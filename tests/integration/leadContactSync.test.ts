/**
 * השלמת פרטי קשר על איש הקשר המקושר, ברקע (ops/leadContactSync.ts): תור עם backoff שורד ריסטרט, בלי יצירת
 * אנשי קשר, בלי דריסת עריכה ידנית, בלי כתיבה כפולה; ועדכון פרטי קשר בליד (update_lead_contact) שמועתק אליו.
 * כל קריאת Monday מוזרקת (fake).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/db.js";
import { enqueueLeadContactSync, getSyncJob, getSyncJobByKey } from "../../src/db/repositories/leadContactSync.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import type { ContactState } from "../../src/integrations/monday/contacts.js";
import { buildContactSyncFields, updateLeadContactAction } from "../../src/ops/actions.js";
import {
  GIVE_UP_AFTER_MS,
  MAX_ERROR_ATTEMPTS,
  backoffMs,
  planContactUpdate,
  processLeadContactSyncJobs,
  type SyncDeps,
} from "../../src/ops/leadContactSync.js";
import { runLeadContactSyncTick } from "../../src/ops/leadContactSyncScheduler.js";

const dov = resolveUserByKey("dov")!;
const T0 = 1_800_000_000_000;

const contact = (over: Partial<ContactState> = {}): ContactState => ({
  id: "c1",
  name: "דנה בן דוד",
  phone: "0501234567",
  email: "",
  whatsapp: "",
  leadIds: ["L1"],
  ...over,
});

beforeEach(() => {
  db.exec("DELETE FROM lead_contact_sync; DELETE FROM notifications;");
});

describe("planContactUpdate — מה כותבים לאיש הקשר", () => {
  it("שדה ריק באיש הקשר → נכתב לעמודה הקיימת של איש הקשר (ווצאפ = phone_mm0mjb42)", () => {
    const p = planContactUpdate(contact(), { whatsapp: { old: null, new: "052-7654321" } }, "L1");
    expect(p.applied).toEqual(["whatsapp"]);
    expect(p.columns).toEqual({ phone_mm0mjb42: { phone: "0527654321", countryShortName: "IL" } }); // מנוקה לספרות
  });

  it("ערך שכבר שווה (גם בפורמט +972 מול 0) → לא נכתב כלום (idempotent)", () => {
    const p = planContactUpdate(contact({ whatsapp: "+972 52-765-4321" }), { whatsapp: { old: null, new: "0527654321" } }, "L1");
    expect(p.columns).toEqual({});
    expect(p.skipped).toEqual([{ field: "whatsapp", reason: "already" }]);
  });

  it("איש הקשר היה מסונכרן עם הערך הישן של הליד → מתעדכן; עריכה ידנית שונה → לא נדרסת", () => {
    const synced = planContactUpdate(contact({ phone: "0501111111" }), { phone: { old: "0501111111", new: "0502222222" } }, "L1");
    expect(synced.columns).toEqual({ phone__1: { phone: "0502222222", countryShortName: "IL" } });
    const manual = planContactUpdate(contact({ phone: "0509999999" }), { phone: { old: "0501111111", new: "0502222222" } }, "L1");
    expect(manual.columns).toEqual({});
    expect(manual.skipped).toEqual([{ field: "phone", reason: "conflict" }]);
  });

  it("איש קשר משותף לליד אחר: ממלאים שדה ריק בלבד, לעולם לא דורסים", () => {
    const shared = contact({ phone: "0501111111", email: "", leadIds: ["L1", "L2"] });
    const p = planContactUpdate(shared, { phone: { old: "0501111111", new: "0502222222" }, email: { old: null, new: "a@b.co" } }, "L1");
    expect(p.applied).toEqual(["email"]);
    expect(p.skipped).toEqual([{ field: "phone", reason: "conflict" }]);
  });

  it("שם: כותבים לשם הפריט (name) רק אם איש הקשר נקרא כמו הליד הישן", () => {
    const ok = planContactUpdate(contact({ name: "דנה כהן" }), { name: { old: "דנה כהן", new: "דנה לוי" } }, "L1");
    expect(ok.columns).toEqual({ name: "דנה לוי" });
    const manual = planContactUpdate(contact({ name: "דנה (לקוחה VIP)" }), { name: { old: "דנה כהן", new: "דנה לוי" } }, "L1");
    expect(manual.columns).toEqual({});
  });
});

describe("תור ההשלמה ברקע", () => {
  const enqueue = (over = {}) =>
    enqueueLeadContactSync({
      idemKey: "form:f1",
      leadItemId: "L1",
      leadName: "בית פרטי",
      userKey: "dov",
      source: "form_create",
      fields: { whatsapp: { old: null, new: "052-7654321" } },
      nowMs: T0,
      ...over,
    });

  function fakes(initial: { ids: string[]; contact?: ContactState | null }) {
    const state = { ids: initial.ids, contact: initial.contact ?? contact(), now: T0 };
    const updateContact = vi.fn(async (_id: string, cols: Record<string, unknown>) => {
      // כמו Monday: הכתיבה משנה את איש הקשר
      if ("phone_mm0mjb42" in cols) state.contact = { ...state.contact!, whatsapp: "052-7654321" };
    });
    const notify = vi.fn();
    const deps: SyncDeps = {
      getLinkedContactIds: async () => state.ids,
      getContact: async () => state.contact,
      updateContact,
      notify,
      nowMs: () => state.now,
    };
    return { state, deps, updateContact, notify };
  }

  it("אותו idem_key לא נכנס פעמיים", () => {
    expect(enqueue()).toBe(true);
    expect(enqueue()).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lead_contact_sync").get()).toEqual({ n: 1 });
  });

  it("איש הקשר עוד לא נוצר → ממתין עם backoff (בלי כתיבה); כשהאוטומציה מקשרת → נכתב פעם אחת על אותו איש קשר; סבב נוסף לא כותב שוב", async () => {
    enqueue();
    const { state, deps, updateContact } = fakes({ ids: [] });

    let r = await processLeadContactSyncJobs(deps);
    expect(r).toMatchObject({ claimed: 1, retried: 1, done: 0 });
    expect(updateContact).not.toHaveBeenCalled();
    let job = getSyncJobByKey("form:f1")!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.nextAttemptMs).toBe(T0 + backoffMs(1));

    // לפני שה-backoff עבר — לא נוגעים
    state.now = T0 + 1000;
    expect(await processLeadContactSyncJobs(deps)).toMatchObject({ claimed: 0 });

    // האוטומציה יצרה וקישרה את איש הקשר
    state.ids = ["c1"];
    state.now = T0 + backoffMs(1) + 1;
    r = await processLeadContactSyncJobs(deps);
    expect(r).toMatchObject({ claimed: 1, done: 1 });
    expect(updateContact).toHaveBeenCalledTimes(1);
    expect(updateContact).toHaveBeenCalledWith("c1", { phone_mm0mjb42: { phone: "0527654321", countryShortName: "IL" } });
    job = getSyncJobByKey("form:f1")!;
    expect(job.status).toBe("done");

    state.now += 10 * 60_000;
    expect(await processLeadContactSyncJobs(deps)).toMatchObject({ claimed: 0 });
    expect(updateContact).toHaveBeenCalledTimes(1);
  });

  it("שני סבבים מקבילים — רק אחד תופס את המשימה (lease) ואין כתיבה כפולה", async () => {
    enqueue();
    const { deps, updateContact } = fakes({ ids: ["c1"] });
    const [a, b] = await Promise.all([processLeadContactSyncJobs(deps), processLeadContactSyncJobs(deps)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(updateContact).toHaveBeenCalledTimes(1);
  });

  it("הפרדה מהליד: ריבוי אנשי קשר מקושרים → ממתינים ולא כותבים; אחרי חלון ה-24 שעות מוותרים ומודיעים למשתמש (הפרטים נשארו בליד)", async () => {
    enqueue();
    const { state, deps, updateContact, notify } = fakes({ ids: ["c1", "c2"] });
    expect(await processLeadContactSyncJobs(deps)).toMatchObject({ retried: 1 });
    expect(updateContact).not.toHaveBeenCalled();

    state.now = T0 + GIVE_UP_AFTER_MS + 1000;
    expect(await processLeadContactSyncJobs(deps)).toMatchObject({ gaveUp: 1 });
    expect(getSyncJobByKey("form:f1")!.status).toBe("gave_up");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual(["dov", expect.stringContaining("הפרטים נשמרו בליד")]);
  });

  it("לא נמצא איש קשר מקושר לאורך כל החלון → מוותרים; לעולם לא נקראת פעולת יצירה (ה-deps בכלל לא כוללים יצירה)", async () => {
    enqueue();
    const { state, deps, updateContact } = fakes({ ids: [] });
    await processLeadContactSyncJobs(deps);
    state.now = T0 + GIVE_UP_AFTER_MS + 1;
    expect(await processLeadContactSyncJobs(deps)).toMatchObject({ gaveUp: 1 });
    expect(updateContact).not.toHaveBeenCalled();
    expect(Object.keys(deps).some((k) => /create/i.test(k))).toBe(false);
  });

  it("שגיאת Monday זמנית → retry עם backoff; אחרי MAX_ERROR_ATTEMPTS ניסיונות → מוותרים ומודיעים", async () => {
    enqueue();
    const { state, deps, notify } = fakes({ ids: ["c1"] });
    deps.getContact = async () => {
      throw new Error("Monday rate limit");
    };
    for (let i = 0; i < MAX_ERROR_ATTEMPTS - 1; i++) {
      state.now += 2 * 60 * 60_000;
      expect(await processLeadContactSyncJobs(deps)).toMatchObject({ retried: 1 });
    }
    state.now += 2 * 60 * 60_000;
    expect(await processLeadContactSyncJobs(deps)).toMatchObject({ gaveUp: 1 });
    expect(getSyncJobByKey("form:f1")!.status).toBe("gave_up");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("ערך שונה שכבר קיים באיש הקשר לא נדרס; המשתמש מקבל הודעה, והמשימה נסגרת", async () => {
    enqueue();
    const { deps, updateContact, notify } = fakes({ ids: ["c1"], contact: contact({ whatsapp: "0541112222" }) });
    expect(await processLeadContactSyncJobs(deps)).toMatchObject({ done: 1 });
    expect(updateContact).not.toHaveBeenCalled();
    expect(getSyncJobByKey("form:f1")!.lastResult).toContain("לא נדרסו");
    expect(notify).toHaveBeenCalledWith("dov", expect.stringContaining("לא דרסתי"));
  });

  it("המשימה שורדת ריסטרט: היא ב-DB ומטופלת בסבב הבא (הטיק של המתזמן)", async () => {
    enqueue();
    const { deps, updateContact } = fakes({ ids: ["c1"] });
    await runLeadContactSyncTick(deps);
    expect(updateContact).toHaveBeenCalledTimes(1);
    expect(getSyncJobByKey("form:f1")!.status).toBe("done");
  });

  it("backoff: 30ש' ← ... ← תקרה של שעה", () => {
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(20)).toBe(60 * 60_000);
  });
});

describe("עדכון פרטי קשר בליד → מועתק לאיש הקשר המקושר", () => {
  const lead = {
    itemId: "9001",
    name: "בית פרטי ברמת גן",
    status: "",
    ownerIds: [dov.mondayUserId!],
    ownerNames: dov.name,
    contactFirstName: "דנה",
    contactLastName: "כהן",
    phone: "0501111111",
    email: undefined,
    url: "u",
  };

  it("buildContactSyncFields: רק מה שהשתנה, עם הערך הישן; שם = פרטי+משפחה", () => {
    expect(buildContactSyncFields(lead, { phone: "0502222222" })).toEqual({ phone: { old: "0501111111", new: "0502222222" } });
    expect(buildContactSyncFields(lead, { email: "d@x.co" })).toEqual({ email: { old: null, new: "d@x.co" } });
    expect(buildContactSyncFields(lead, { lastName: "לוי" })).toEqual({ name: { old: "דנה כהן", new: "דנה לוי" } });
    expect(buildContactSyncFields(lead, { institutionName: "קהילה" })).toEqual({}); // אין עמודה באיש הקשר
    expect(buildContactSyncFields(lead, { firstName: "דנה", lastName: "כהן" })).toEqual({}); // לא השתנה
  });

  it("update_lead_contact: הליד מתעדכן כמו קודם, ובנוסף נכנסת משימת רקע; כשל בתור לא מכשיל את העדכון", async () => {
    const enq = vi.fn(() => true);
    const update = vi.fn(async () => ["phone"] as never);
    const r = await updateLeadContactAction(dov, { itemId: "9001", phone: "0502222222" }, {
      getLeadRecordById: async () => lead,
      updateLeadContactColumns: update,
      enqueueContactSync: enq,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(r.message).toContain("ויועתקו לאיש הקשר המקושר ברקע");
    expect(enq.mock.calls[0]![0]).toMatchObject({ leadItemId: "9001", source: "lead_update", userKey: "dov", fields: { phone: { old: "0501111111", new: "0502222222" } } });

    const broken = vi.fn(() => {
      throw new Error("db locked");
    });
    const r2 = await updateLeadContactAction(dov, { itemId: "9001", phone: "0503333333" }, {
      getLeadRecordById: async () => lead,
      updateLeadContactColumns: update,
      enqueueContactSync: broken,
    });
    expect(r2.ok).toBe(true);
    expect(r2.message).not.toContain("ברקע");
  });

  it("עדכון שלא משפיע על איש הקשר (שם מוסד בלבד) לא יוצר משימה", async () => {
    const enq = vi.fn(() => true);
    await updateLeadContactAction(dov, { itemId: "9001", institutionName: "קהילה" }, {
      getLeadRecordById: async () => lead,
      updateLeadContactColumns: async () => ["institutionName"],
      enqueueContactSync: enq,
    });
    expect(enq).not.toHaveBeenCalled();
    expect(getSyncJob(1)).toBeNull();
  });
});
