/**
 * getUserTasksFetchDiagnostics (opsRead.ts) — מדידת pages/items/durationMs פר-חבר-צוות/מקור
 * (audit 2026-10-15, בדיקת היתכנות pagination). Mock ל-mondayRequest בלבד (client.ts) — אין
 * Monday/AI אמיתיים. בודק: רישום רק כש-meta מועבר (לא זולג לקריאות בודדות), שיוך בטוח ל-generation
 * (לא מתערבב בין generations שונים ובין חברי-צוות שונים באותו generation), ומדידת pagination בפועל.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mondayRequestMock } = vi.hoisted(() => ({ mondayRequestMock: vi.fn() }));

vi.mock(import("../../src/integrations/monday/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mondayRequest: mondayRequestMock };
});

import { fetchUserOpsTasks, getUserTasksFetchDiagnostics } from "../../src/integrations/monday/opsRead.js";

const EMPTY_PAGE = { boards: [{ items_page: { cursor: null, items: [] as unknown[] } }] };

function mkRawItem(id: string) {
  return { id, name: `item-${id}`, column_values: [] as unknown[] };
}

beforeEach(() => {
  mondayRequestMock.mockReset();
});

describe("getUserTasksFetchDiagnostics", () => {
  it("בלי meta (כמו chat.ts/dashboard.ts) — שום דבר לא נרשם", async () => {
    mondayRequestMock.mockResolvedValue(EMPTY_PAGE);
    await fetchUserOpsTasks("12345"); // בלי meta
    expect(getUserTasksFetchDiagnostics(777001)).toEqual([]); // generation שלא נגענו בו כלל
  });

  it("עם meta — נרשמים 2 שלבים (general+project_stage), teamIndex נכון, בלי שם/מזהה בתוכן", async () => {
    mondayRequestMock.mockResolvedValue(EMPTY_PAGE);
    const generation = 101;
    await fetchUserOpsTasks("12345", { generation, teamIndex: 3 });
    const steps = getUserTasksFetchDiagnostics(generation);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.teamIndex === 3)).toBe(true);
    expect(steps.map((s) => s.source).sort()).toEqual(["general", "project_stage"]);
    expect(steps.every((s) => s.pages === 1 && s.items === 0)).toBe(true);
    expect(steps.every((s) => typeof s.durationMs === "number" && s.durationMs >= 0)).toBe(true);
    // אין בשום שדה מזהה Monday/שם — רק המבנה המוצהר (teamIndex/source/pages/items/durationMs)
    for (const s of steps) expect(Object.keys(s).sort()).toEqual(["durationMs", "items", "pages", "source", "teamIndex"]);
  });

  it("pagination אמיתי — עמוד שני מעלה pages ל-2 ומצטבר items משני העמודים", async () => {
    const generation = 202;
    mondayRequestMock.mockImplementation(async (query: string) => {
      if (query.includes("boards(ids:")) {
        return { boards: [{ items_page: { cursor: "cur1", items: [mkRawItem("a"), mkRawItem("b")] } }] };
      }
      return { next_items_page: { cursor: null, items: [mkRawItem("c")] } };
    });
    await fetchUserOpsTasks("77777", { generation, teamIndex: 0 });
    const steps = getUserTasksFetchDiagnostics(generation);
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s.pages).toBe(2);
      expect(s.items).toBe(3); // 2 (עמוד 1) + 1 (עמוד 2), לפני סינון סטטוס בלקוח
    }
  });

  it("שני generations שונים לא מתערבבים — כל אחד בדלי משלו", async () => {
    mondayRequestMock.mockResolvedValue(EMPTY_PAGE);
    await fetchUserOpsTasks("111", { generation: 301, teamIndex: 0 });
    await fetchUserOpsTasks("222", { generation: 302, teamIndex: 1 });
    expect(getUserTasksFetchDiagnostics(301)).toHaveLength(2);
    expect(getUserTasksFetchDiagnostics(302)).toHaveLength(2);
    expect(getUserTasksFetchDiagnostics(301).every((s) => s.teamIndex === 0)).toBe(true);
    expect(getUserTasksFetchDiagnostics(302).every((s) => s.teamIndex === 1)).toBe(true);
  });

  it("שני חברי-צוות באותו generation (קריאות מקבילות של mapPool) — שתיהן נרשמות יחד, לא דורסות זו את זו", async () => {
    mondayRequestMock.mockResolvedValue(EMPTY_PAGE);
    const generation = 404;
    await Promise.all([
      fetchUserOpsTasks("111", { generation, teamIndex: 0 }),
      fetchUserOpsTasks("222", { generation, teamIndex: 1 }),
    ]);
    const steps = getUserTasksFetchDiagnostics(generation);
    expect(steps).toHaveLength(4); // 2 חברים × 2 מקורות
    expect(new Set(steps.map((s) => s.teamIndex))).toEqual(new Set([0, 1]));
  });

  // ───────────────────────── limit: 200→500 (2026-10-15) ─────────────────────────

  it("items_page ו-next_items_page משתמשות ב-limit:500 (לא 200) — בשני המקורות", async () => {
    mondayRequestMock.mockImplementation(async (query: string) => {
      if (query.includes("boards(ids:")) {
        // cursor לא-null מאלץ קריאה גם ל-next_items_page, כדי לבדוק את שתי הצורות
        return { boards: [{ items_page: { cursor: "cur1", items: [] } }] };
      }
      return { next_items_page: { cursor: null, items: [] } };
    });
    await fetchUserOpsTasks("555555", { generation: 601, teamIndex: 0 });
    const queries = mondayRequestMock.mock.calls.map(([q]: [string]) => q);
    expect(queries).toHaveLength(4); // (items_page + next_items_page) × 2 מקורות
    for (const q of queries) {
      expect(q).toContain("limit: 500");
      expect(q).not.toContain("limit: 200");
    }
  });

  it("יותר מ-500 פריטים בעמוד הראשון — pagination ממשיכה כצפוי: cursor מכבד, items מצטברים נכון, pages=2", async () => {
    const generation = 602;
    mondayRequestMock.mockImplementation(async (query: string) => {
      if (query.includes("boards(ids:")) {
        const items = Array.from({ length: 500 }, (_, i) => mkRawItem(`p1-${i}`));
        return { boards: [{ items_page: { cursor: "cur-page-2", items } }] };
      }
      const items = Array.from({ length: 40 }, (_, i) => mkRawItem(`p2-${i}`));
      return { next_items_page: { cursor: null, items } };
    });
    await fetchUserOpsTasks("666666", { generation, teamIndex: 1 });
    const steps = getUserTasksFetchDiagnostics(generation);
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s.pages).toBe(2);
      expect(s.items).toBe(540); // 500 (עמוד 1, בדיוק במכסה החדשה) + 40 (עמוד 2)
    }
  });
});
