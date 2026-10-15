/**
 * Single-flight ל-getReverseDependencyMap (src/integrations/monday/opsRead.ts) — בקשות מקבילות
 * כש-cache קר (TTL 5 דק') צריכות לחלוק סריקה אחת של כל בורד תת-המשימות (1550734556), לא שתיים.
 * אין force בפונקציה הזו (לא היה ולא נוסף) — אין צורך לבדוק סמנטיקת force/race-מול-force כאן,
 * ר' tests/unit/officeStateSingleFlight.test.ts לכך.
 *
 * Mock ל-mondayRequest (client.ts) בלבד — אין Monday אמיתי (גם לו היה, networkGuard חוסם).
 * vi.resetModules() + import דינמי בכל בדיקה כדי שה-cache/inFlight המודולריים יתחילו נקיים.
 * רישום ה-mock (vi.mock) עצמו שורד resetModules — רק מטמון המודולים מתאפס, לא רישומי ה-mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mondayRequestMock } = vi.hoisted(() => ({ mondayRequestMock: vi.fn() }));

vi.mock(import("../../src/integrations/monday/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mondayRequest: mondayRequestMock };
});

/** עמוד ריק (cursor=null) — מדלג על לוגיקת ה-pagination, לא רלוונטית לבדיקת single-flight. */
const EMPTY_PAGE = { boards: [{ items_page: { cursor: null, items: [] as unknown[] } }] };

async function freshGetReverseDependencyMap() {
  const mod = await import("../../src/integrations/monday/opsRead.js");
  return mod.getReverseDependencyMap;
}

beforeEach(() => {
  mondayRequestMock.mockReset();
  vi.resetModules();
});

describe("single-flight — getReverseDependencyMap", () => {
  it("שתי קריאות מקבילות כש-cache קר גורמות לסריקה אחת של Monday, לא שתיים", async () => {
    mondayRequestMock.mockResolvedValue(EMPTY_PAGE);
    const getReverseDependencyMap = await freshGetReverseDependencyMap();

    const [m1, m2] = await Promise.all([getReverseDependencyMap(), getReverseDependencyMap()]);

    expect(m1).toBe(m2); // אותה מפה בדיוק — סריקה משותפת
    expect(mondayRequestMock).toHaveBeenCalledTimes(1); // לא פי 2
  });

  it("כישלון מנקה את ה-in-flight ומאפשר ניסיון חוזר מוצלח (ולא נשמר כ-cache)", async () => {
    let shouldFail = true;
    // הודעת שגיאה שלא תואמת את ה-RETRYABLE regex ב-client.ts — נכשלת מיידית, בלי backoff של 2/4/8 שניות
    mondayRequestMock.mockImplementation(() =>
      shouldFail ? Promise.reject(new Error("Monday down - בדיקה")) : Promise.resolve(EMPTY_PAGE),
    );
    const getReverseDependencyMap = await freshGetReverseDependencyMap();

    await expect(getReverseDependencyMap()).rejects.toThrow("Monday down");

    // אם ה-in-flight לא היה מתנקה בכישלון, הקריאה הבאה הייתה חוזרת על אותה הבטחה שנדחתה.
    shouldFail = false;
    const map = await getReverseDependencyMap();
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it("cache תקף (תוך 5 דק') מוחזר כרגיל, בלי סריקה חדשה", async () => {
    mondayRequestMock.mockResolvedValue(EMPTY_PAGE);
    const getReverseDependencyMap = await freshGetReverseDependencyMap();

    const m1 = await getReverseDependencyMap();
    mondayRequestMock.mockClear();

    const m2 = await getReverseDependencyMap();
    expect(m2).toBe(m1);
    expect(mondayRequestMock).not.toHaveBeenCalled();
  });

  // אין force בפונקציה הזו (לא היה ולא נוסף) — ולכן אין דרך לבנות כאן שתי שליפות *חופפות בזמן*
  // שלא מצטרפות זו לזו: כל קריאה שנייה כש-cache תקף (TTL 5 דק') פשוט מקבלת את ה-cache (ר' הבדיקה
  // למעלה), וכל קריאה שנייה בזמן שהראשונה עדיין רצה מצטרפת ל-in-flight שלה (ר' הבדיקה הראשונה).
  // single-flight מונע race אמיתי כאן *במבנה* — ההגנה "startedAt >= cache.sourceStartedAt" קיימת
  // לסימטריה עם officeState.ts (ששם force כן פותח race אמיתי — ר' officeStateSingleFlight.test.ts).
});

// ───────────────────────── limit: 200→500 (2026-10-15) ─────────────────────────
// מראה עבור fetchReverseDependencyMap את שתי הבדיקות שנוספו בעבר ל-fetchGeneralTasks/
// fetchProjectStageTasks (tests/unit/userTasksFetchDiagnostics.test.ts): (1) הערך בפועל
// בשתי צורות ה-pagination, (2) ש-pagination אמיתי מעבר לעמוד אחד עדיין מצטבר/ממפה נכון —
// כולל ששמירת STAGE_TASK_DONE (סינון לקוח) ממשיכה לעבוד נכון גם כשהתוצאה מגיעה מכמה עמודים.
function mkItem(
  id: string,
  opts: { status?: string; blockerIds?: string[]; assignees?: string; project?: string } = {},
): Record<string, unknown> {
  return {
    id,
    name: `item-${id}`,
    column_values: [
      { id: "dependency__1", text: null, linked_item_ids: opts.blockerIds ?? [] },
      { id: "color85__1", text: opts.status ?? "בעבודה" },
      { id: "person", text: opts.assignees ?? "" },
    ],
    parent_item: opts.project
      ? { column_values: [{ id: "connect_boards4__1", text: null, display_value: opts.project }] }
      : null,
  };
}

describe("fetchReverseDependencyMap — limit: 200→500", () => {
  it("items_page ו-next_items_page משתמשות ב-limit:500 (לא 200)", async () => {
    mondayRequestMock.mockImplementation(async (query: string) => {
      if (query.includes("boards(ids:")) {
        return { boards: [{ items_page: { cursor: "cur1", items: [] } }] };
      }
      return { next_items_page: { cursor: null, items: [] } };
    });
    const getReverseDependencyMap = await freshGetReverseDependencyMap();
    await getReverseDependencyMap();

    const queries = mondayRequestMock.mock.calls.map(([q]: [string]) => q);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q).toContain("limit: 500");
      expect(q).not.toContain("limit: 200");
    }
  });

  it("יותר מ-500 פריטים (עמוד שני) — pagination ממשיכה כצפוי, אותה מפת תלויות נבנית נכון", async () => {
    // עמוד 1 (500, בדיוק במכסה החדשה): 498 מילוי בלי תלות, 1 "הושלם" עם תלות (צריך להיות מסונן
    // בלקוח כמו קודם), 1 תקין עם תלות ל-blocker1.
    const fillers = Array.from({ length: 498 }, (_, i) => mkItem(`filler-${i}`));
    const doneWithDep = mkItem("done-with-dep", { status: "הושלם", blockerIds: ["blocker1"] });
    const depA = mkItem("dep-A", { status: "בעבודה", blockerIds: ["blocker1"], assignees: "דוב", project: "פרויקט X" });
    const page1Items = [...fillers, doneWithDep, depA];
    expect(page1Items).toHaveLength(500);

    const depB = mkItem("dep-B", { status: "תקוע", blockerIds: ["blocker2"], assignees: "איתן" });

    mondayRequestMock.mockImplementation(async (query: string) => {
      if (query.includes("boards(ids:")) {
        return { boards: [{ items_page: { cursor: "cur-page-2", items: page1Items } }] };
      }
      return { next_items_page: { cursor: null, items: [depB] } };
    });

    const getReverseDependencyMap = await freshGetReverseDependencyMap();
    const map = await getReverseDependencyMap();

    expect(mondayRequestMock).toHaveBeenCalledTimes(2); // עמוד 1 + עמוד 2, לא יותר
    expect(map.size).toBe(2); // blocker1 (מעמוד 1), blocker2 (מעמוד 2)
    expect(map.get("blocker1")).toEqual([
      { itemId: "dep-A", name: "item-dep-A", assignees: "דוב", project: "פרויקט X" },
    ]); // "done-with-dep" מסונן — STAGE_TASK_DONE ממשיך לעבוד נכון גם לאורך כמה עמודים
    expect(map.get("blocker2")).toEqual([{ itemId: "dep-B", name: "item-dep-B", assignees: "איתן", project: "" }]);
  });
});
