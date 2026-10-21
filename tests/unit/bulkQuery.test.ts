/**
 * מנוע הסינון (src/ops/bulkQuery.ts) + שליפת הלידים עם pagination (src/integrations/monday/bulkRead.ts).
 * Monday מדומה בלבד: fetchers מוזרקים דרך deps, ו-mondayRequest מוחלף ב-vi.mock לבדיקת ה-pagination.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

const { mondayRequestMock } = vi.hoisted(() => ({ mondayRequestMock: vi.fn() }));
vi.mock(import("../../src/integrations/monday/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mondayRequest: mondayRequestMock as unknown as typeof actual.mondayRequest };
});

import { resolveUserByKey } from "../../src/identity/index.js";
import {
  applyFilters,
  compileFilters,
  formatQueryText,
  mergeFilters,
  runBulkQuery,
  type BulkFilters,
  type BulkRecord,
} from "../../src/ops/bulkQuery.js";
import { fetchLeadsForBulk, type BulkLead } from "../../src/integrations/monday/bulkRead.js";
import type { OpsTask, ProjectMeta } from "../../src/integrations/monday/opsRead.js";

const NOW = DateTime.fromISO("2026-10-21T10:00", { zone: "Asia/Jerusalem" }); // רביעי
const moti = resolveUserByKey("moti")!;
const dov = resolveUserByKey("dov")!;
const eitan = resolveUserByKey("eitan")!;
const ruchama = resolveUserByKey("ruchama")!;

function task(itemId: string, over: Partial<OpsTask> = {}): OpsTask {
  return {
    source: "general",
    itemId,
    name: `משימה ${itemId}`,
    url: `https://x.test/${itemId}`,
    context: "משימת משרד",
    status: "לביצוע",
    assignees: "",
    ...over,
  };
}
function rec(itemId: string, over: Partial<BulkRecord> = {}): BulkRecord {
  return { itemId, kind: "general", name: `רשומה ${itemId}`, status: "לביצוע", assignees: "", url: "", ...over };
}
const compile = (f: Partial<BulkFilters>) => compileFilters({ recordType: "tasks", ...f } as BulkFilters, NOW);

beforeEach(() => mondayRequestMock.mockReset());

// ───────────────────────── סינון — תנאי יחיד ומשולב ─────────────────────────

describe("applyFilters", () => {
  const rows = [
    rec("1", { date: "2026-10-22", project: "בית כנסת רמות", status: "בעבודה", priority: "קריטי ⚠️" }),
    rec("2", { date: "2026-10-22", project: "מעון יום גבעת שאול", status: "תקוע" }),
    rec("3", { date: "2026-10-15", project: "בית כנסת רמות", status: "לביצוע", priority: "גבוה" }),
    rec("4", { project: "בית כנסת רמות", status: "מתתין ליועץ/ספק/אחר", kind: "project_stage" }),
    rec("5", { date: "2026-10-28", status: "ממתין להתייחסות", priority: "נמוך" }),
  ];
  const ids = (out: BulkRecord[]) => out.map((r) => r.itemId);

  it("תאריך יחיד — מחר", () => expect(ids(applyFilters(rows, compile({ date: "מחר" })))).toEqual(["1", "2"]));
  it("באיחור", () => expect(ids(applyFilters(rows, compile({ overdue: true })))).toEqual(["3"]));
  it("בלי תאריך", () => expect(ids(applyFilters(rows, compile({ noDate: true })))).toEqual(["4"]));
  it("פרויקט (חלק מהשם)", () => expect(ids(applyFilters(rows, compile({ projects: ["רמות"] })))).toEqual(["3", "1", "4"]));
  it("משולב: פרויקט + תאריך + סטטוס", () => {
    expect(ids(applyFilters(rows, compile({ projects: ["רמות"], date: "מחר", statuses: ["בעבודה"] })))).toEqual(["1"]);
  });
  it("משולב: תעדוף 'דחוף' = קריטי+גבוה (אמוג'י בתווית לא מפריע)", () => {
    expect(ids(applyFilters(rows, compile({ priorities: ["קריטי", "גבוה"] })))).toEqual(["3", "1"]);
  });
  it("'ממתין' תופס גם את התווית עם שגיאת הכתיב 'מתתין'", () => {
    expect(ids(applyFilters(rows, compile({ statuses: ["ממתין"] })))).toEqual(["5", "4"]);
  });
  it("חוץ מפרויקט", () => expect(ids(applyFilters(rows, compile({ date: "מחר", excludeProjects: ["מעון"] })))).toEqual(["1"]));
  it("טווח — השבוע", () => expect(ids(applyFilters(rows, compile({ date: "השבוע" })))).toEqual(["1", "2"]));
  it("טווח פתוח — עד יום ראשון", () => expect(ids(applyFilters(rows, compile({ dateTo: "יום ראשון" })))).toEqual(["3", "1", "2"]));
  it("פרויקטים פעילים בלבד", () => {
    const withIds = rows.map((r, i) => ({ ...r, projectId: r.project ? `p${i}` : undefined }));
    expect(ids(applyFilters(withIds, compile({ activeProjectsOnly: true }), new Set(["p0"])))).toEqual(["1"]);
  });
  it("לידים: סגורים מוסתרים כברירת מחדל, ומוצגים כשמבקשים אותם במפורש", () => {
    const leads = [rec("L1", { kind: "lead", status: "פולואפ" }), rec("L2", { kind: "lead", status: "לא רלוונטי" })];
    const lc = (f: Partial<BulkFilters>) => compileFilters({ recordType: "leads", ...f } as BulkFilters, NOW);
    expect(ids(applyFilters(leads, lc({})))).toEqual(["L1"]);
    expect(ids(applyFilters(leads, lc({ statuses: ["לא רלוונטי"] })))).toEqual(["L2"]);
  });
  it("לידים 'פתוחים' לא כוללים 'עבר לעסקה'/'הוקפא' (כמו crmScan), אלא אם ביקשו במפורש", () => {
    const leads = [
      rec("L1", { kind: "lead", status: "פולואפ" }),
      rec("L2", { kind: "lead", status: "עבר לעסקה" }),
      rec("L3", { kind: "lead", status: "הוקפא" }),
    ];
    const lc = (f: Partial<BulkFilters>) => compileFilters({ recordType: "leads", ...f } as BulkFilters, NOW);
    expect(ids(applyFilters(leads, lc({})))).toEqual(["L1"]);
    expect(ids(applyFilters(leads, lc({ statuses: ["עבר לעסקה"] })))).toEqual(["L2"]);
    expect(ids(applyFilters(leads, lc({ includeClosed: true }))).sort()).toEqual(["L1", "L2", "L3"]);
  });
  it("'בלי סטטוס' = תווית ריקה (נפוץ בנתוני אמת), לא 0 תוצאות", () => {
    const rows2 = [rec("a", { status: "" }), rec("b", { status: "בעבודה" }), rec("c", { status: "טרם הוגדר" })];
    expect(ids(applyFilters(rows2, compile({ statuses: ["בלי סטטוס"] })))).toEqual(["a"]);
    expect(ids(applyFilters(rows2, compile({ statuses: [""] })))).toEqual(["a"]);
    expect(ids(applyFilters(rows2, compile({ excludeStatuses: ["ללא סטטוס"] }))).sort()).toEqual(["b", "c"]);
  });
  it("לידים: לא עודכנו השבוע", () => {
    const leads = [
      rec("L1", { kind: "lead", status: "פולואפ", updatedAt: "2026-10-10T08:00:00Z" }),
      rec("L2", { kind: "lead", status: "פולואפ", updatedAt: "2026-10-20T08:00:00Z" }),
    ];
    const c = compileFilters({ recordType: "leads", notUpdatedSince: "השבוע" }, NOW);
    expect(ids(applyFilters(leads, c))).toEqual(["L1"]);
  });
});

describe("compileFilters — אימות לפני Monday", () => {
  it("תאריך לא מובן → שגיאה שמבקשת לשאול", () => expect(() => compile({ date: "אחרי החג" })).toThrow(/שאל את המשתמש/));
  it("סתירה: בלי תאריך + איחור", () => expect(() => compile({ noDate: true, overdue: true })).toThrow(/סותר/));
  it("משימות שבוצעו — לא נתמך, נאמר במפורש", () => expect(() => compile({ statuses: ["בוצע"] })).toThrow(/פתוחות/));
  it("ללידים אין פרויקט/תעדוף", () => {
    expect(() => compileFilters({ recordType: "leads", projects: ["x"] }, NOW)).toThrow();
    expect(() => compileFilters({ recordType: "leads", priorities: ["גבוה"] }, NOW)).toThrow();
  });
  it("סוג רשומות לא נתמך", () => expect(() => compileFilters({ recordType: "deals" } as unknown as BulkFilters, NOW)).toThrow(/לא נתמך/));
});

describe("mergeFilters — בקשות המשך", () => {
  it("'חוץ מפרויקט X' מצטבר על הסינון הקודם", () => {
    const prev: BulkFilters = { recordType: "tasks", assignees: ["איתן"], date: "מחר", excludeProjects: ["A"] };
    expect(mergeFilters(prev, { excludeProjects: ["B"] })).toEqual({ recordType: "tasks", assignees: ["איתן"], date: "מחר", excludeProjects: ["A", "B"] });
  });
  it("שינוי סינון דורס, וטווח חדש מבטל תאריך יחיד", () => {
    const prev: BulkFilters = { recordType: "tasks", assignees: ["איתן"], date: "מחר" };
    expect(mergeFilters(prev, { assignees: ["דוב"], dateFrom: "השבוע" })).toEqual({ recordType: "tasks", assignees: ["דוב"], dateFrom: "השבוע" });
  });
});

// ───────────────────────── runBulkQuery — הרשאות, שלמות, כשל ─────────────────────────

describe("runBulkQuery — משימות", () => {
  it("בלי assignees → רק המשימות של המשתמש עצמו", async () => {
    const fetch = vi.fn(async () => [task("1", { dueDate: "2026-10-22" })]);
    const o = await runBulkQuery(dov, { recordType: "tasks", date: "מחר" }, NOW, { fetchUserOpsTasks: fetch });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(dov.mondayUserId);
    expect(o.ok && o.records.length).toBe(1);
  });

  it("שרטטת לא רואה משימות של אחרים — בלי שליפה בכלל", async () => {
    const fetch = vi.fn(async () => []);
    const o = await runBulkQuery(ruchama, { recordType: "tasks", assignees: ["איתן"] }, NOW, { fetchUserOpsTasks: fetch });
    expect(o.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("מנהל פרויקט רואה משימות של אחר רק בפרויקטים שהוא מנהל", async () => {
    const projects: ProjectMeta[] = [
      { itemId: "P1", name: "שלי", owner: "", ownerIds: [dov.mondayUserId!], status: "", groupTitle: "" },
      { itemId: "P2", name: "לא שלי", owner: "", ownerIds: [eitan.mondayUserId!], status: "", groupTitle: "" },
    ];
    const fetch = vi.fn(async () => [task("a", { projectId: "P1", context: "שלי" }), task("b", { projectId: "P2", context: "לא שלי" }), task("c")]);
    const o = await runBulkQuery(dov, { recordType: "tasks", assignees: ["רוחמה"] }, NOW, { fetchUserOpsTasks: fetch, fetchActiveProjects: async () => projects });
    expect(o.ok && o.records.map((r) => r.itemId)).toEqual(["a"]);
    expect(o.ok && o.notes.join(" ")).toMatch(/2 משימות/);
  });

  it("בעלים רואה הכל, מכמה אנשים, בלי כפילויות (משימה עם שני אחראים)", async () => {
    const fetch = vi.fn(async (id: string) => (id === dov.mondayUserId ? [task("1"), task("shared")] : [task("2"), task("shared")]));
    const o = await runBulkQuery(moti, { recordType: "tasks", assignees: ["דוב", "איתן"] }, NOW, { fetchUserOpsTasks: fetch });
    expect(o.ok && o.records.map((r) => r.itemId).sort()).toEqual(["1", "2", "shared"]);
    expect(o.ok && o.complete).toBe(true);
  });

  it("כשל במקור אחד → complete=false + פירוט, לא '0 תוצאות' בשקט", async () => {
    const fetch = vi.fn(async (id: string) => {
      if (id === eitan.mondayUserId) throw new Error("timeout");
      return [task("1")];
    });
    const o = await runBulkQuery(moti, { recordType: "tasks", assignees: ["דוב", "איתן"] }, NOW, { fetchUserOpsTasks: fetch });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.complete).toBe(false);
    expect(o.failures).toEqual(["המשימות של איתן ברמן"]);
    expect(formatQueryText(o)).toMatch(/השליפה חלקית/);
  });

  it("כשל מלא → ok:false (שגיאה), לא רשימה ריקה", async () => {
    const o = await runBulkQuery(dov, { recordType: "tasks" }, NOW, { fetchUserOpsTasks: async () => { throw new Error("down"); } });
    expect(o.ok).toBe(false);
  });

  it("אפס תוצאות — הודעה מפורשת עם הסינון", async () => {
    const o = await runBulkQuery(dov, { recordType: "tasks", date: "מחר" }, NOW, { fetchUserOpsTasks: async () => [] });
    expect(o.ok && formatQueryText(o)).toMatch(/^לא נמצאו משימות שתואמות לסינון/);
  });

  it("אדם לא מוכר / תאריך לא מובן — שגיאה לפני שליפה", async () => {
    const fetch = vi.fn(async () => []);
    expect((await runBulkQuery(moti, { recordType: "tasks", assignees: ["זלמן"] }, NOW, { fetchUserOpsTasks: fetch })).ok).toBe(false);
    expect((await runBulkQuery(moti, { recordType: "tasks", date: "אחרי החג" }, NOW, { fetchUserOpsTasks: fetch })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("רשימה ארוכה — מספר מלא + 'ועוד N', לא קיצור שקט", async () => {
    const many = Array.from({ length: 55 }, (_, i) => task(String(i + 1)));
    const o = await runBulkQuery(dov, { recordType: "tasks" }, NOW, { fetchUserOpsTasks: async () => many });
    const text = o.ok ? formatQueryText(o) : "";
    expect(text).toMatch(/^נמצאו 55 משימות/);
    expect(text).toMatch(/ועוד 15 \(מוצגות 40 הראשונות מתוך 55\)/);
  });
});

describe("runBulkQuery — לידים", () => {
  const lead = (itemId: string, ownerIds: string[], over: Partial<BulkLead> = {}): BulkLead => ({
    itemId, name: `ליד ${itemId}`, status: "פולואפ", owner: "", ownerIds, source: "", product: "", url: "", ...over,
  });

  it("מנהל פרויקט — רק הלידים שלו, וסינון האחראי נשלח ל-Monday", async () => {
    const fetch = vi.fn(async () => [lead("1", [dov.mondayUserId!]), lead("2", [moti.mondayUserId!])]);
    const o = await runBulkQuery(dov, { recordType: "leads" }, NOW, { fetchLeadsForBulk: fetch });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(dov.mondayUserId);
    expect(o.ok && o.records.map((r) => r.itemId)).toEqual(["1"]);
  });
  it("מנהל פרויקט שמבקש לידים של אחר — נדחה", async () => {
    expect((await runBulkQuery(dov, { recordType: "leads", assignees: ["מוטי"] }, NOW, { fetchLeadsForBulk: async () => [] })).ok).toBe(false);
  });
  it("שרטטת — אין הרשאה ללידים", async () => {
    expect((await runBulkQuery(ruchama, { recordType: "leads" }, NOW, { fetchLeadsForBulk: async () => [] })).ok).toBe(false);
  });
  it("בעלים — כל הלידים, תזכורת שעברה", async () => {
    const fetch = vi.fn(async () => [lead("1", [], { reminderDate: "2026-10-01" }), lead("2", [], { reminderDate: "2026-11-01" })]);
    const o = await runBulkQuery(moti, { recordType: "leads", overdue: true }, NOW, { fetchLeadsForBulk: fetch });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(o.ok && o.records.map((r) => r.itemId)).toEqual(["1"]);
  });
});

// ───────────────────────── pagination — fetchLeadsForBulk ─────────────────────────

describe("fetchLeadsForBulk — pagination מלאה", () => {
  const item = (id: string) => ({ id, name: `L${id}`, updated_at: "2026-10-01T00:00:00Z", column_values: [] });

  it("עוקב אחרי ה-cursor עד הסוף — כל העמודים, לא רק הראשון", async () => {
    mondayRequestMock
      .mockResolvedValueOnce({ boards: [{ items_page: { cursor: "c1", items: [item("1"), item("2")] } }] })
      .mockResolvedValueOnce({ next_items_page: { cursor: "c2", items: [item("3")] } })
      .mockResolvedValueOnce({ next_items_page: { cursor: null, items: [item("4")] } });
    const leads = await fetchLeadsForBulk();
    expect(leads.map((l) => l.itemId)).toEqual(["1", "2", "3", "4"]);
    expect(mondayRequestMock).toHaveBeenCalledTimes(3);
    expect(mondayRequestMock.mock.calls[1]![1]).toEqual({ cursor: "c1" });
  });

  it("כשל בעמוד שני → זורק (לא מחזיר עמוד ראשון כאילו הוא הכל)", async () => {
    mondayRequestMock
      .mockResolvedValueOnce({ boards: [{ items_page: { cursor: "c1", items: [item("1")] } }] })
      .mockRejectedValueOnce(new Error("complexity budget exhausted"));
    await expect(fetchLeadsForBulk()).rejects.toThrow();
  });

  it("סינון אחראי בצד Monday", async () => {
    mondayRequestMock.mockResolvedValueOnce({ boards: [{ items_page: { cursor: null, items: [] } }] });
    await fetchLeadsForBulk("62982081");
    expect(String(mondayRequestMock.mock.calls[0]![0])).toContain('compare_value: ["person-62982081"]');
  });
});
