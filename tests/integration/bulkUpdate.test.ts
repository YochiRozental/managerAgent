/**
 * עדכון קבוצתי (src/ops/bulkUpdate.ts) — DB זמני מבודד, Monday מוזרק (deps) בלבד: אף כתיבה אמיתית.
 *
 * מכסה: תצוגה לפני ביצוע · אין ביצוע בלי אישור / באותה הודעה / באישור מסויג · שינוי ב-Monday
 * מאז התצוגה → לא נכתב כלום · כשל חלקי מדווח · אישור חוזר לא מבצע שוב · הרשאות פר-רשומה ·
 * קבוצה חלקית חסומה · תאריך לא מובן לא מנוחש.
 */

import { describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { resolveUserByKey, type IdentifiedUser } from "../../src/identity/index.js";
import { saveResultSet } from "../../src/db/repositories/bulkOps.js";
import {
  authorizeBulkItem,
  confirmBulkUpdate,
  isExplicitConfirmation,
  prepareBulkUpdate,
  snapshotDiff,
  type BulkUpdateDeps,
} from "../../src/ops/bulkUpdate.js";
import type { ItemSnapshot } from "../../src/integrations/monday/bulkRead.js";

const NOW = DateTime.fromISO("2026-10-21T10:00", { zone: "Asia/Jerusalem" });
const moti = resolveUserByKey("moti")!;
const dov = resolveUserByKey("dov")!;
const ruchama = resolveUserByKey("ruchama")!;

let seq = 0;
const newSession = () => `bulk-s${++seq}`;

function snap(itemId: string, over: Partial<ItemSnapshot> = {}): ItemSnapshot {
  return {
    itemId,
    kind: "general",
    boardId: "1550734526",
    name: `משימה ${itemId}`,
    status: "לביצוע",
    date: "2026-10-22",
    assigneeIds: [dov.mondayUserId!],
    ...over,
  };
}

/** Monday מדומה: מצב בזיכרון, כתיבות נרשמות ומשנות את המצב. */
function fakeMonday(initial: ItemSnapshot[], opts: { failWriteFor?: string[] } = {}) {
  const state = new Map(initial.map((s) => [s.itemId, { ...s }]));
  const writes: { itemId: string; values: Record<string, unknown> }[] = [];
  const notes: string[] = [];
  const deps: BulkUpdateDeps = {
    readItemsForVerification: vi.fn(async (ids: string[]) => {
      const m = new Map<string, ItemSnapshot>();
      for (const id of ids) if (state.has(id)) m.set(id, { ...state.get(id)!, assigneeIds: [...state.get(id)!.assigneeIds] });
      return m;
    }),
    setItemColumnValues: vi.fn(async (_board: string, itemId: string, values: Record<string, unknown>) => {
      if (opts.failWriteFor?.includes(itemId)) throw new Error("Monday 500");
      writes.push({ itemId, values });
      const s = state.get(itemId)!;
      for (const v of Object.values(values) as Record<string, unknown>[]) {
        if ("date" in v) s.date = v.date as string;
        if ("label" in v) s.status = v.label as string;
      }
    }),
    addTaskNote: vi.fn(async (_id: string, body: string) => void notes.push(body)),
    getProjectOwnerIds: vi.fn(async (pid: string) => (pid === "P-dov" ? [dov.mondayUserId!] : ["99999"])),
    getColumnLabels: vi.fn(async () => ["קריטי ⚠️", "גבוה", "בינוני", "נמוך"]),
  };
  return { state, writes, notes, deps };
}

function seedSet(user: IdentifiedUser, sessionId: string, items: ItemSnapshot[], complete = true) {
  return saveResultSet({
    userKey: user.key,
    sessionId,
    recordType: items[0]?.kind === "lead" ? "leads" : "tasks",
    filters: { recordType: "tasks", date: "מחר" },
    filtersText: "משימות פתוחות · תאריך יעד: 22/10",
    records: items.map((s) => ({ itemId: s.itemId, kind: s.kind, name: s.name })),
    complete,
  });
}

const ctx = (sessionId: string, turnId: string) => ({ sessionId, turnId, now: NOW });

describe("isExplicitConfirmation", () => {
  it.each(["כן", "כן, תבצע", "מאשר", "מאשרת!", "תבצע", "יאללה", "ok", "בסדר גמור", "✅"])("'%s' = אישור", (t) =>
    expect(isExplicitConfirmation(t)).toBe(true));
  it.each(["לא", "רגע", "כן אבל בלי הפרויקט של רמות", "כן? מה זה יעשה", "תשנה ליום שני", "חוץ מהשלישית", "", "מה?", "בטל"])(
    "'%s' ≠ אישור", (t) => expect(isExplicitConfirmation(t)).toBe(false));
});

describe("prepare → confirm: הזרימה התקינה", () => {
  it("תצוגה לא כותבת כלום; אישור בהודעה הבאה מבצע בדיוק את הרשומות שהוצגו", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1"), snap("2"), snap("3", { date: undefined })]);
    seedSet(dov, s, [...m.state.values()]);

    const prep = await prepareBulkUpdate(dov, ctx(s, "turn-1"), { change: { dueDate: "יום ראשון הבא" } }, m.deps);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.text).toMatch(/עדיין לא בוצע שום שינוי/);
    expect(prep.text).toMatch(/יעודכנו 3 משימות/);
    expect(prep.text).toMatch(/22\/10 → 25\/10/);
    expect(m.writes).toHaveLength(0);

    const conf = await confirmBulkUpdate(dov, { ...ctx(s, "turn-2"), latestUserMessage: "כן" }, {}, m.deps);
    expect(conf.ok && conf.executed).toBe(true);
    expect(m.writes.map((w) => w.itemId)).toEqual(["1", "2", "3"]);
    expect(m.writes[0]!.values).toEqual({ date4: { date: "2026-10-25" } });
    expect(conf.ok && conf.text).toMatch(/✅ עודכנו 3 משימות בהצלחה/);
  });

  it("הזזה יחסית (shiftDays) — רשומה בלי תאריך מוחרגת ומדווחת", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1"), snap("2", { date: undefined })]);
    seedSet(dov, s, [...m.state.values()]);
    const prep = await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { shiftDays: 2 } }, m.deps);
    expect(prep.ok && prep.text).toMatch(/22\/10 → 24\/10/);
    expect(prep.ok && prep.text).toMatch(/משימה 2 — אין לה תאריך להזיז/);
  });
});

describe("אין ביצוע בלי אישור מפורש", () => {
  async function prepared() {
    const s = newSession();
    const m = fakeMonday([snap("1"), snap("2")]);
    seedSet(dov, s, [...m.state.values()]);
    const prep = await prepareBulkUpdate(dov, ctx(s, "turn-A"), { change: { status: "בעבודה" } }, m.deps);
    expect(prep.ok).toBe(true);
    return { s, m };
  }

  it("באותה הודעה שבה הוכנה התצוגה — נדחה, גם אם המשתמש כתב 'כן'", async () => {
    const { s, m } = await prepared();
    const r = await confirmBulkUpdate(dov, { ...ctx(s, "turn-A"), latestUserMessage: "כן" }, {}, m.deps);
    expect(r.ok).toBe(false);
    expect(m.writes).toHaveLength(0);
  });

  it("הודעה שאינה אישור (בקשת שינוי) — נדחה, לא נכתב כלום", async () => {
    const { s, m } = await prepared();
    const r = await confirmBulkUpdate(dov, { ...ctx(s, "turn-B"), latestUserMessage: "כן אבל חוץ מהשנייה" }, {}, m.deps);
    expect(r.ok).toBe(false);
    expect(m.writes).toHaveLength(0);
  });

  it("משתמש אחר / שיחה אחרת לא יכולים לאשר את התוכנית", async () => {
    const { s, m } = await prepared();
    expect((await confirmBulkUpdate(moti, { ...ctx(s, "x"), latestUserMessage: "כן" }, {}, m.deps)).ok).toBe(false);
    expect((await confirmBulkUpdate(dov, { ...ctx("other-session", "x"), latestUserMessage: "כן" }, {}, m.deps)).ok).toBe(false);
    expect(m.writes).toHaveLength(0);
  });

  it("תצוגה שפגה — לא מתבצעת", async () => {
    const { s, m } = await prepared();
    const later = { sessionId: s, turnId: "late", now: NOW.plus({ minutes: 31 }), latestUserMessage: "כן" };
    expect((await confirmBulkUpdate(dov, later, {}, m.deps)).ok).toBe(false);
    expect(m.writes).toHaveLength(0);
  });

  it("אין תוכנית בכלל — 'כן' לא עושה כלום", async () => {
    const m = fakeMonday([]);
    expect((await confirmBulkUpdate(dov, { ...ctx(newSession(), "t"), latestUserMessage: "כן" }, {}, m.deps)).ok).toBe(false);
  });
});

describe("מניעת עדכון כפול", () => {
  it("אישור חוזר אחרי ביצוע — מחזיר את הדוח, לא כותב שוב", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1"), snap("2")]);
    seedSet(dov, s, [...m.state.values()]);
    const prep = await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { status: "בעבודה" } }, m.deps);
    const planId = prep.ok ? prep.planId : undefined;
    await confirmBulkUpdate(dov, { ...ctx(s, "t2"), latestUserMessage: "כן" }, {}, m.deps);
    expect(m.writes).toHaveLength(2);

    const again = await confirmBulkUpdate(dov, { ...ctx(s, "t3"), latestUserMessage: "כן" }, { planId }, m.deps);
    expect(again.ok && again.executed).toBe(false);
    expect(again.ok && again.text).toMatch(/כבר בוצע/);
    expect(m.writes).toHaveLength(2);
  });

  it("שני אישורים מקבילים — רק אחד מבצע (CAS)", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1")]);
    seedSet(dov, s, [...m.state.values()]);
    await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { status: "בעבודה" } }, m.deps);
    const [a, b] = await Promise.all([
      confirmBulkUpdate(dov, { ...ctx(s, "t2"), latestUserMessage: "כן" }, {}, m.deps),
      confirmBulkUpdate(dov, { ...ctx(s, "t2b"), latestUserMessage: "כן" }, {}, m.deps),
    ]);
    expect(m.writes).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && r.executed)).toHaveLength(1);
  });

  it("תצוגה חדשה מחליפה את הקודמת — רק האחרונה ניתנת לאישור", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1")]);
    seedSet(dov, s, [...m.state.values()]);
    const first = await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { status: "בעבודה" } }, m.deps);
    await prepareBulkUpdate(dov, ctx(s, "t2"), { change: { status: "תקוע" } }, m.deps);
    const old = await confirmBulkUpdate(dov, { ...ctx(s, "t3"), latestUserMessage: "כן" }, { planId: first.ok ? first.planId : "" }, m.deps);
    expect(old.ok).toBe(false);
    expect(m.writes).toHaveLength(0);
  });
});

describe("שינוי ב-Monday בין התצוגה לביצוע", () => {
  it("רשומה שהשתנתה → לא נכתב *כלום* (גם לא לרשומות שלא השתנו), התוכנית stale", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1"), snap("2")]);
    seedSet(dov, s, [...m.state.values()]);
    await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { dueDate: "25/10" } }, m.deps);
    m.state.get("2")!.status = "תקוע"; // מישהו שינה ב-Monday בינתיים

    const r = await confirmBulkUpdate(dov, { ...ctx(s, "t2"), latestUserMessage: "כן" }, {}, m.deps);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/משימה 2 — סטטוס \(לביצוע → תקוע\)/);
    expect(m.writes).toHaveLength(0);
    // ואישור נוסף לא "מחייה" אותה
    expect((await confirmBulkUpdate(dov, { ...ctx(s, "t3"), latestUserMessage: "כן" }, {}, m.deps)).ok).toBe(false);
    expect(m.writes).toHaveLength(0);
  });

  it("רשומה שנמחקה בינתיים → stale", () => {
    expect(snapshotDiff(snap("1"), undefined)).toEqual(["הרשומה לא נמצאה יותר ב-Monday"]);
    expect(snapshotDiff(snap("1"), snap("1"))).toEqual([]);
    expect(snapshotDiff(snap("1"), snap("1", { assigneeIds: ["1"] }))).toEqual(["אחראי/ת"]);
  });

  it("כשל בקריאת האימות → לא נכתב כלום, ואפשר לאשר שוב אחר כך", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1")]);
    seedSet(dov, s, [...m.state.values()]);
    await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { status: "בעבודה" } }, m.deps);
    const failingRead = { ...m.deps, readItemsForVerification: async () => { throw new Error("network"); } };
    expect((await confirmBulkUpdate(dov, { ...ctx(s, "t2"), latestUserMessage: "כן" }, {}, failingRead)).ok).toBe(false);
    expect(m.writes).toHaveLength(0);
    const retry = await confirmBulkUpdate(dov, { ...ctx(s, "t3"), latestUserMessage: "כן" }, {}, m.deps);
    expect(retry.ok && retry.executed).toBe(true);
    expect(m.writes).toHaveLength(1);
  });
});

describe("כשל חלקי", () => {
  it("רשומה שנכשלה בכתיבה מדווחת; השאר מתבצעות; אין ניסיון חוזר אוטומטי", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1"), snap("2"), snap("3")], { failWriteFor: ["2"] });
    seedSet(dov, s, [...m.state.values()]);
    await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { status: "בעבודה" } }, m.deps);
    const r = await confirmBulkUpdate(dov, { ...ctx(s, "t2"), latestUserMessage: "כן" }, {}, m.deps);
    expect(r.ok && r.text).toMatch(/הושלם חלקית: עודכנו 2 מתוך 3/);
    expect(r.ok && r.text).toMatch(/משימה 2 — Monday 500/);
    expect(m.writes.map((w) => w.itemId)).toEqual(["1", "3"]);
  });
});

describe("הרשאות", () => {
  it("שרטטת: סטטוס על המשימות שלה — מותר; שינוי תאריך — חסום (מדיניות הדחיות)", async () => {
    const s = newSession();
    const mine = (id: string) => snap(id, { assigneeIds: [ruchama.mondayUserId!], kind: "project_stage", boardId: "1550734556", projectId: "P-dov" });
    const m = fakeMonday([mine("1"), mine("2")]);
    seedSet(ruchama, s, [...m.state.values()]);
    expect((await prepareBulkUpdate(ruchama, ctx(s, "t1"), { change: { status: "בעבודה" } }, m.deps)).ok).toBe(true);
    const dates = await prepareBulkUpdate(ruchama, ctx(s, "t2"), { change: { dueDate: "25/10" } }, m.deps);
    expect(dates.ok).toBe(false);
    expect(!dates.ok && dates.error).toMatch(/הרשאת ניהול משימות/);
  });

  it("מנהל פרויקט: משימות של אחר — רק בפרויקט שהוא מנהל; השאר מוחרגות עם סיבה", async () => {
    const s = newSession();
    const other = (id: string, projectId?: string) =>
      snap(id, { assigneeIds: [ruchama.mondayUserId!], kind: "project_stage", boardId: "1550734556", projectId });
    const m = fakeMonday([other("1", "P-dov"), other("2", "P-eitan"), other("3", undefined)]);
    seedSet(dov, s, [...m.state.values()]);
    const prep = await prepareBulkUpdate(dov, ctx(s, "t1"), { change: { dueDate: "25/10" } }, m.deps);
    expect(prep.ok && prep.text).toMatch(/יעודכנו 1 משימות/);
    expect(prep.ok && prep.text).toMatch(/משימה 2 — המשימה בפרויקט שאינך מנהל\/ת/);
    expect(prep.ok && prep.text).toMatch(/משימה 3 — לא זוהה הפרויקט/);
  });

  it("ביטול ('לא רלוונטי') — רק לבעלים, לא למנהל פרויקט", async () => {
    const stage = snap("1", { kind: "project_stage", boardId: "1550734556" });
    expect(authorizeBulkItem(dov, stage, { status: "לא רלוונטי" }, new Map()).ok).toBe(false);
    expect(authorizeBulkItem(moti, stage, { status: "לא רלוונטי" }, new Map()).ok).toBe(true);
  });

  it("לידים: מנהל פרויקט רק על הלידים שלו", () => {
    const lead = (owner: string) => snap("L", { kind: "lead", boardId: "1550734525", assigneeIds: [owner] });
    expect(authorizeBulkItem(dov, lead(dov.mondayUserId!), { date: "2026-10-25" }, new Map()).ok).toBe(true);
    expect(authorizeBulkItem(dov, lead(moti.mondayUserId!), { date: "2026-10-25" }, new Map()).ok).toBe(false);
    expect(authorizeBulkItem(ruchama, lead(ruchama.mondayUserId!), { date: "2026-10-25" }, new Map()).ok).toBe(false);
  });

  it("העברת אחראי: נכתבת עמודת people + Update שמתעד מי ביצע", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1")]);
    seedSet(moti, s, [...m.state.values()]);
    const prep = await prepareBulkUpdate(moti, ctx(s, "t1"), { change: { assignee: "איתן" } }, m.deps);
    expect(prep.ok && prep.text).toMatch(/אחראי\/ת → איתן ברמן/);
    await confirmBulkUpdate(moti, { ...ctx(s, "t2"), latestUserMessage: "מאשר" }, {}, m.deps);
    expect(m.writes[0]!.values).toEqual({ person: { personsAndTeams: [{ id: 62981836, kind: "person" }] } });
    expect(m.notes[0]).toMatch(/ע"י מוטי דרך עדכון קבוצתי/);
  });
});

describe("שמירות לפני תוכנית", () => {
  it("קבוצת תוצאות חלקית — אסור לעדכן", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1")]);
    seedSet(dov, s, [...m.state.values()], false);
    const r = await prepareBulkUpdate(dov, ctx(s, "t"), { change: { status: "בעבודה" } }, m.deps);
    expect(!r.ok && r.error).toMatch(/חלקית/);
    expect(m.deps.readItemsForVerification).not.toHaveBeenCalled();
  });

  it("'אחרי החג' — לא מנוחש, מבקש תאריך", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1")]);
    seedSet(dov, s, [...m.state.values()]);
    const r = await prepareBulkUpdate(dov, ctx(s, "t"), { change: { dueDate: "אחרי החג" } }, m.deps);
    expect(!r.ok && r.error).toMatch(/אל תנחש/);
  });

  it("סטטוס עמום ('ממתין' במשימות פרויקט = שתי תוויות) — שואלים, לא בוחרים", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1", { kind: "project_stage", boardId: "1550734556" })]);
    seedSet(dov, s, [...m.state.values()]);
    const r = await prepareBulkUpdate(dov, ctx(s, "t"), { change: { status: "ממתין" } }, m.deps);
    expect(!r.ok && r.error).toMatch(/מתאים לכמה סטטוסים/);
  });

  it("תעדוף: 'קריטי' מתמפה לתווית האמיתית עם האמוג'י", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1")]);
    seedSet(moti, s, [...m.state.values()]);
    const r = await prepareBulkUpdate(moti, ctx(s, "t"), { change: { priority: "קריטי" } }, m.deps);
    expect(r.ok && r.text).toMatch(/→ קריטי ⚠️/);
  });

  it("רשומה שכבר במצב המבוקש — מוחרגת, לא נכתבת", async () => {
    const s = newSession();
    const m = fakeMonday([snap("1", { status: "בעבודה" }), snap("2")]);
    seedSet(dov, s, [...m.state.values()]);
    const r = await prepareBulkUpdate(dov, ctx(s, "t"), { change: { status: "בעבודה" } }, m.deps);
    expect(r.ok && r.text).toMatch(/משימה 1 — כבר במצב המבוקש/);
    expect(r.ok && r.text).toMatch(/יעודכנו 1 משימות/);
  });
});
