/**
 * מניעת כפילות אחרי ניתוק (טפסי יצירה): Monday יצר את הפריט אבל התשובה לא הגיעה / השרת קרס לפני שסימן הצלחה.
 * checkpoint נשמר מיד אחרי היצירה; ניסיון שני בלי checkpoint מתאים מצב מול Monday (קריאה בלבד) לפני שיוצרים; ולא
 * מנסים שוב create_item על timeout. כל קריאת Monday מוזרקת / mondayClient.request מודבק.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/db.js";
import { getFormRequest } from "../../src/db/repositories/formRequests.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { mondayClient, mondayRequest } from "../../src/integrations/monday/client.js";
import type { createLeadAction, createTaskAction } from "../../src/ops/actions.js";
import { findCreatedInMonday, targetFor } from "../../src/ops/forms/reconcile.js";
import { FormError, openForm, submitForm, type FormServiceDeps } from "../../src/ops/forms/service.js";

const dov = resolveUserByKey("dov")!;
const OPTIONS = {
  getColumnLabels: async (_b: string, c: string) => (c === "color5__1" ? ["בית ספר"] : c === "color1__1" ? ["אתר"] : ["גבוה"]),
  fetchActiveProjects: async () => [],
  getProjectStages: async () => [],
};
let seq = 0;
const openTask = () => openForm(dov, "task", { taskName: "להתקשר ליועץ" }, { sessionId: "s", seed: `d-${Date.now()}-${seq++}` });
const openLead = () => openForm(dov, "lead", {}, { sessionId: "s", seed: `d-${Date.now()}-${seq++}` });
const LEAD = { contactName: "דנה בן דוד", phone: "0501234567", projectName: "בית פרטי", projectType: "בית ספר" };

const taskResult = (id = "5001") => ({ ok: true as const, itemId: id, itemName: "להתקשר ליועץ", source: "general" as const, assigneeName: "x", message: 'נוצרה משימה "להתקשר ליועץ"', deduped: false });
const deps = (over: FormServiceDeps = {}): FormServiceDeps => ({ options: OPTIONS, appendHistory: () => undefined, ...over });
const makeStale = (id: string) => db.prepare("UPDATE form_requests SET status = 'submitting', updated_at = datetime('now', '-10 minutes') WHERE id = ?").run(id);

beforeEach(() => {
  db.exec("DELETE FROM form_requests; DELETE FROM commitments;");
});

describe("checkpoint — קריסה אחרי שהפריט נוצר", () => {
  it("הפריט נשמר ב-checkpoint מיד אחרי היצירה (עוד לפני סימון הצלחה)", async () => {
    const f = openTask();
    let checkpointDuringFollowups: string | null = null;
    const create = vi.fn(async () => taskResult());
    await submitForm(dov, f.id, { values: f.values }, deps({ createTaskAction: create as unknown as typeof createTaskAction }));
    checkpointDuringFollowups = getFormRequest(f.id)!.checkpointJson;
    expect(JSON.parse(checkpointDuringFollowups!).created).toMatchObject({ itemId: "5001" });
  });

  it("השרת קרס אחרי היצירה (submitting תקוע + checkpoint) → תפיסה מחדש ממשיכה מה-checkpoint: אין יצירה שנייה ואין חיפוש", async () => {
    const f = openTask();
    const create = vi.fn(async () => taskResult());
    const findCreated = vi.fn(async () => []);
    // ניסיון ראשון שהצליח ליצור אבל "קרס" לפני markFormSubmitted: מחזירים את השורה למצב submitting תקוע
    await submitForm(dov, f.id, { values: f.values }, deps({ createTaskAction: create as unknown as typeof createTaskAction }));
    db.prepare("UPDATE form_requests SET status = 'submitting', result_json = NULL WHERE id = ?").run(f.id);
    makeStale(f.id);

    const out = await submitForm(dov, f.id, { values: f.values }, deps({ createTaskAction: create as unknown as typeof createTaskAction, findCreated }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(findCreated).not.toHaveBeenCalled();
    expect(out.form.status).toBe("submitted");
    expect(out.form.result?.itemId).toBe("5001");
  });

  it("ליד: קריסה אחרי היצירה ולפני שלבי ההמשך → ההמשך מושלם פעם אחת בלבד (Update, תור ווצאפ), בלי ליד שני", async () => {
    const createLead = vi.fn(async () => ({ ok: true as const, itemId: "8001", itemName: "בית פרטי", message: 'נוצר ליד "בית פרטי"', deduped: false }));
    const update = vi.fn(async () => undefined);
    const enqueue = vi.fn(() => true);
    const d = deps({ createLeadAction: createLead as unknown as typeof createLeadAction, addUpdate: update, enqueueContactSync: enqueue });
    const f = openLead();

    // ניסיון 1: Update נכשל (נניח ניתוק) — הליד כבר נוצר ונשמר ב-checkpoint, אבל Update לא תועד
    const failingUpdate = vi.fn(async () => {
      throw new Error("timeout");
    });
    await submitForm(dov, f.id, { values: { ...LEAD, whatsapp: "052-7654321" }, none: { email: true } }, { ...d, addUpdate: failingUpdate });
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // השרת "קרס" לפני markFormSubmitted → ניסיון נוסף אחרי התקיעות
    db.prepare("UPDATE form_requests SET status = 'submitting', result_json = NULL WHERE id = ?").run(f.id);
    makeStale(f.id);
    await submitForm(dov, f.id, { values: { ...LEAD, whatsapp: "052-7654321" }, none: { email: true } }, d);
    expect(createLead).toHaveBeenCalledTimes(1); // לא נוצר ליד שני
    expect(update).toHaveBeenCalledTimes(1); // ה-Update שנכשל הושלם עכשיו
    expect(enqueue).toHaveBeenCalledTimes(1); // תור הווצאפ כבר נרשם — לא שוב
  });
});

describe("ניתוק לפני שה-Action חזר (תוצאה לא ודאית) — התאמת מצב לפני יצירה חוזרת", () => {
  it("Monday יצר את הפריט והתשובה אבדה → ניסיון שני מוצא אותו ומאמץ: אין יצירה שנייה, יש קישור, ו-checkpoint מסומן adopted", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(taskResult("SHOULD-NOT-BE-USED"));
    const findCreated = vi.fn(async () => [{ itemId: "7777", name: "להתקשר ליועץ" }]);
    const d = deps({ createTaskAction: create as unknown as typeof createTaskAction, findCreated });
    const f = openTask();

    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toMatchObject({ status: 422 });
    expect(findCreated).not.toHaveBeenCalled();

    const out = await submitForm(dov, f.id, { values: f.values }, d);
    expect(create).toHaveBeenCalledTimes(1);
    expect(findCreated).toHaveBeenCalledTimes(1);
    expect(findCreated.mock.calls[0]![2]).toBe(getFormRequest(f.id)!.firstAttemptMs);
    expect(out.form.result).toMatchObject({ itemId: "7777", url: expect.stringContaining("/boards/1550734526/pulses/7777") });
    expect(out.form.result?.message).toContain("לא יצרתי כפילות");
    expect(JSON.parse(getFormRequest(f.id)!.checkpointJson!)).toMatchObject({ adopted: true, created: { itemId: "7777" } });
  });

  it("לא נמצא כלום → יוצרים (הניסיון הקודם באמת לא יצר)", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(taskResult("9"));
    const d = deps({ createTaskAction: create as unknown as typeof createTaskAction, findCreated: async () => [] });
    const f = openTask();
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toBeInstanceOf(FormError);
    const out = await submitForm(dov, f.id, { values: f.values }, d);
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.form.result?.itemId).toBe("9");
  });

  it("לא ניתן לוודא (החיפוש נכשל) → לא יוצרים מחדש בעיוור: 409 והטופס נשאר פתוח עם הסבר", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(taskResult());
    const d = deps({
      createTaskAction: create as unknown as typeof createTaskAction,
      findCreated: async () => {
        throw new Error("Monday לא זמין");
      },
    });
    const f = openTask();
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toMatchObject({ status: 422 });
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("לא ניתן לוודא") });
    expect(create).toHaveBeenCalledTimes(1);
    expect(getFormRequest(f.id)).toMatchObject({ status: "open" });
    expect(getFormRequest(f.id)!.lastError).toContain("לא ניתן לוודא");
  });

  it("כמה מועמדים תואמים → לא מנחשים ולא יוצרים (409)", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(taskResult());
    const d = deps({
      createTaskAction: create as unknown as typeof createTaskAction,
      findCreated: async () => [
        { itemId: "1", name: "להתקשר ליועץ" },
        { itemId: "2", name: "להתקשר ליועץ" },
      ],
    });
    const f = openTask();
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toMatchObject({ status: 422 });
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("פריט זהה שנוצר מכוון ע\"י טופס אחר לא מאומץ בטעות — יוצרים את שלנו", async () => {
    const createdByOther = vi.fn(async () => taskResult("4242"));
    const other = openTask();
    await submitForm(dov, other.id, { values: other.values }, deps({ createTaskAction: createdByOther as unknown as typeof createTaskAction }));

    const create = vi.fn().mockRejectedValueOnce(new Error("socket")).mockResolvedValueOnce(taskResult("4343"));
    const d = deps({ createTaskAction: create as unknown as typeof createTaskAction, findCreated: async () => [{ itemId: "4242", name: "להתקשר ליועץ" }] });
    const f = openTask();
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toBeInstanceOf(FormError);
    const out = await submitForm(dov, f.id, { values: f.values }, d);
    expect(out.form.result?.itemId).toBe("4343");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("submitting תקוע (קריסה לפני שה-Action חזר, בלי checkpoint) → תפיסה מחדש מתאימה מצב לפני יצירה", async () => {
    const f = openTask();
    db.prepare("UPDATE form_requests SET status = 'submitting', attempts = 1, first_attempt_ms = ? WHERE id = ?").run(Date.now() - 600_000, f.id);
    makeStale(f.id);
    const create = vi.fn(async () => taskResult("1"));
    const findCreated = vi.fn(async () => [{ itemId: "5555", name: "להתקשר ליועץ" }]);
    const out = await submitForm(dov, f.id, { values: f.values }, deps({ createTaskAction: create as unknown as typeof createTaskAction, findCreated }));
    expect(create).not.toHaveBeenCalled();
    expect(out.form.result?.itemId).toBe("5555");
  });

  it("התחייבות: נשמרה בניסיון שנקטע → מאומצת, בלי שורה שנייה", async () => {
    const f = openForm(dov, "commitment", { toWhom: "לקוח כהן", what: "לשלוח הצעה" }, { sessionId: "s", seed: `d-${seq++}` });
    db.prepare("UPDATE form_requests SET status = 'submitting', attempts = 1, first_attempt_ms = ? WHERE id = ?").run(Date.now() - 5_000, f.id);
    makeStale(f.id);
    db.prepare("INSERT INTO commitments (created_by, to_whom, what) VALUES ('dov', 'לקוח כהן', 'לשלוח הצעה')").run();
    const out = await submitForm(dov, f.id, { values: f.values }, deps());
    expect(out.form.result?.message).toContain("לא שמרתי כפילות");
    expect(db.prepare("SELECT COUNT(*) AS n FROM commitments").get()).toEqual({ n: 1 });
  });

  it("ליד: אותה התאמה לפי שם הפרויקט בלוח הלידים", async () => {
    const createLead = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue({ ok: true, itemId: "x", itemName: "x", message: "x", deduped: false });
    const findCreated = vi.fn(async () => [{ itemId: "8123", name: "בית פרטי" }]);
    const d = deps({ createLeadAction: createLead as unknown as typeof createLeadAction, findCreated, enqueueContactSync: () => true, addUpdate: async () => undefined });
    const f = openLead();
    await expect(submitForm(dov, f.id, { values: LEAD }, d)).rejects.toBeInstanceOf(FormError);
    const out = await submitForm(dov, f.id, { values: LEAD }, d);
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(out.form.result?.url).toContain("/boards/1550734525/pulses/8123");
  });
});

describe("findCreatedInMonday (קריאה בלבד)", () => {
  const original = mondayClient.request.bind(mondayClient);
  afterEach(() => {
    (mondayClient as unknown as { request: typeof mondayClient.request }).request = original;
  });
  const fake = (items: unknown[]) => {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    (mondayClient as unknown as { request: typeof mondayClient.request }).request = (async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      return { boards: [{ items_page: { items } }] };
    }) as typeof mondayClient.request;
    return calls;
  };
  const SINCE = Date.parse("2026-11-02T10:00:00Z");

  it("מסנן לפי שם (בלי רגישות לרווחים/אותיות) ולפי זמן יצירה מאז הניסיון הראשון; שולח שאילתה בלבד (לא mutation)", async () => {
    const calls = fake([
      { id: "1", name: "  בית   פרטי ", created_at: "2026-11-02T10:00:30Z" },
      { id: "2", name: "בית פרטי", created_at: "2026-11-02T09:00:00Z" }, // ישן — לא שלנו
      { id: "3", name: "פרויקט אחר", created_at: "2026-11-02T10:01:00Z" },
    ]);
    const r = await findCreatedInMonday("lead", { projectName: "בית פרטי" }, SINCE);
    expect(r).toEqual([{ itemId: "1", name: "  בית   פרטי " }]);
    expect(calls[0]!.query).not.toContain("mutation");
    expect(calls[0]!.variables).toEqual({ boardId: "1550734525" });
  });

  it("הלוח לפי סוג: משימה כללית / משימת שלב / שלב; התחייבות — אין פריט Monday", () => {
    expect(targetFor("task", { taskName: "a", scope: "general" })!.boardId).toBe("1550734526");
    expect(targetFor("task", { taskName: "a", scope: "stage" })!.boardId).toBe("1550734556");
    expect(targetFor("stage", { name: "a" })!.boardId).toBe("1550734531");
    expect(targetFor("commitment", {})).toBeNull();
  });

  it("תשובה בלי פריטים (לוח לא קריא) → זורק, כדי שהקורא לא יניח 'לא נוצר'", async () => {
    (mondayClient as unknown as { request: typeof mondayClient.request }).request = (async () => ({ boards: [] })) as typeof mondayClient.request;
    await expect(findCreatedInMonday("lead", { projectName: "x" }, SINCE)).rejects.toThrow();
  });
});

describe("mondayRequest — אין retry על יצירה כשהתוצאה לא ודאית", () => {
  const original = mondayClient.request.bind(mondayClient);
  afterEach(() => {
    (mondayClient as unknown as { request: typeof mondayClient.request }).request = original;
  });
  const failing = (msg: string) => {
    let n = 0;
    (mondayClient as unknown as { request: typeof mondayClient.request }).request = (async () => {
      n++;
      throw new Error(msg);
    }) as typeof mondayClient.request;
    return () => n;
  };
  const CREATE = `mutation { create_item(board_id: 1, item_name: "x") { id } }`;

  it("create_item + timeout/ניתוק/503 → ניסיון אחד בלבד (Monday ייתכן שכבר יצר)", async () => {
    for (const msg of ["Request timeout", "ECONNRESET", "503 Service Unavailable"]) {
      const calls = failing(msg);
      await expect(mondayRequest(CREATE, undefined, 3)).rejects.toThrow(msg);
      expect(calls()).toBe(1);
    }
    const sub = failing("timeout");
    await expect(mondayRequest(`mutation { create_subitem(parent_item_id: 1, item_name: "x") { id } }`, undefined, 3)).rejects.toThrow();
    expect(sub()).toBe(1);
  });

  it("שאילתה/עדכון (לא יצירה) ממשיכים להתנסות שוב על timeout כמו קודם", async () => {
    const calls = failing("Request timeout");
    await expect(mondayRequest(`query { me { id } }`, undefined, 2)).rejects.toThrow("timeout");
    expect(calls()).toBe(2);
  }, 15_000);
});
