/**
 * סינון סטטוסים סגורים בצד Monday ל-fetchProjectStageTasks (2026-10-16, feature flag
 * STAGE_STATUS_SERVER_FILTER_ENABLED). Mock ל-mondayRequest (client.js) + env מדומה (mutable,
 * אותו דפוס כמו tests/integration/promptCachingExperiment.test.ts) — אין Monday/AI אמיתיים.
 *
 * vi.resetModules() + import דינמי בכל בדיקה כדי שה-cache/inFlight של getStageDoneLabelResolution
 * (ב-opsRead.ts) יתחילו נקיים בכל פעם — אין מפתח generation כאן (בניגוד ל-single-flight האחרים),
 * כך שבלי resetModules תוצאה מבדיקה אחת תדלוף לבדיקה הבאה.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mondayRequestMock } = vi.hoisted(() => ({ mondayRequestMock: vi.fn() }));

vi.mock(import("../../src/integrations/monday/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mondayRequest: mondayRequestMock };
});

vi.mock(import("../../src/config/env.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, env: { ...actual.env } };
});

const EMPTY_ITEMS_PAGE = { boards: [{ items_page: { cursor: null, items: [] as unknown[] } }] };

function labelSettings(labels: Record<string, string>) {
  return { boards: [{ columns: [{ id: "color85__1", settings_str: JSON.stringify({ labels }) }] }] };
}

function isSettingsQuery(q: string) {
  return q.includes("settings_str");
}
function isItemsPageQuery(q: string) {
  return q.includes("boards(ids:") && q.includes("items_page");
}

async function freshFetchProjectStageTasks() {
  const mod = await import("../../src/integrations/monday/opsRead.js");
  return mod.fetchProjectStageTasks;
}
async function freshEnv() {
  const mod = await import("../../src/config/env.js");
  return mod.env;
}

beforeEach(() => {
  mondayRequestMock.mockReset();
  vi.resetModules();
});

describe("STAGE_STATUS_SERVER_FILTER_ENABLED — flag", () => {
  it("flag כבוי (ברירת מחדל) — אין שאילתת settings_str, ואין not_any_of בשאילתת המשימות", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = false;
    mondayRequestMock.mockResolvedValue(EMPTY_ITEMS_PAGE);

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    await fetchProjectStageTasks("12345");

    const queries = mondayRequestMock.mock.calls.map(([q]: [string]) => q);
    expect(queries.some(isSettingsQuery)).toBe(false);
    expect(queries.every((q) => !q.includes("not_any_of"))).toBe(true);
  });
});

describe("STAGE_STATUS_SERVER_FILTER_ENABLED — מיפוי תוויות", () => {
  it("מיפוי חד-משמעי — מוסיף not_any_of עם ה-IDs שנגזרו מה-settings, לא 1/9 קבועים", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    mondayRequestMock.mockImplementation(async (q: string) =>
      isSettingsQuery(q) ? labelSettings({ "3": "בעבודה", "7": "הושלם", "2": "תקוע", "11": "לא רלוונטי" }) : EMPTY_ITEMS_PAGE,
    );

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    await fetchProjectStageTasks("12345");

    const itemsQuery = mondayRequestMock.mock.calls.map(([q]: [string]) => q).find(isItemsPageQuery);
    expect(itemsQuery).toContain("not_any_of");
    expect(itemsQuery).toContain("[7,11]"); // נגזר מה-mock, לא קבוע בקוד
  });

  it("תווית 'לא רלוונטי' חסרה — לא חד-משמעי, fallback בלי not_any_of", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    mondayRequestMock.mockImplementation(async (q: string) =>
      isSettingsQuery(q) ? labelSettings({ "1": "הושלם" }) : EMPTY_ITEMS_PAGE,
    );

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    await fetchProjectStageTasks("12345");

    const itemsQuery = mondayRequestMock.mock.calls.map(([q]: [string]) => q).find(isItemsPageQuery);
    expect(itemsQuery).not.toContain("not_any_of");
  });

  it("שתי תוויות עם אותו טקסט ('הושלם' כפול) — לא חד-משמעי, fallback בלי not_any_of", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    mondayRequestMock.mockImplementation(async (q: string) =>
      isSettingsQuery(q) ? labelSettings({ "1": "הושלם", "2": "הושלם", "9": "לא רלוונטי" }) : EMPTY_ITEMS_PAGE,
    );

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    await fetchProjectStageTasks("12345");

    const itemsQuery = mondayRequestMock.mock.calls.map(([q]: [string]) => q).find(isItemsPageQuery);
    expect(itemsQuery).not.toContain("not_any_of");
  });

  it("שליפת settings_str נכשלת (שגיאת רשת) — fallback בלי not_any_of, לא קורס", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    mondayRequestMock.mockImplementation(async (q: string) => {
      if (isSettingsQuery(q)) throw new Error("Monday network error - simulated");
      return EMPTY_ITEMS_PAGE;
    });

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    const tasks = await fetchProjectStageTasks("12345");

    expect(tasks).toEqual([]);
    const itemsQuery = mondayRequestMock.mock.calls.map(([q]: [string]) => q).find(isItemsPageQuery);
    expect(itemsQuery).not.toContain("not_any_of");
  });
});

describe("STAGE_STATUS_SERVER_FILTER_ENABLED — מטמון + single-flight", () => {
  it("single-flight — 5 חברי צוות מקבילים חולקים שליפת settings_str אחת, לא פר-חבר", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    let settingsCalls = 0;
    mondayRequestMock.mockImplementation(async (q: string) => {
      if (isSettingsQuery(q)) {
        settingsCalls++;
        return labelSettings({ "1": "הושלם", "9": "לא רלוונטי" });
      }
      return EMPTY_ITEMS_PAGE;
    });

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    await Promise.all(["111", "222", "333", "444", "555"].map((id) => fetchProjectStageTasks(id)));

    expect(settingsCalls).toBe(1);
  });

  it("תוצאת 'לא חד-משמעי' נשמרת ב-cache — קריאה שנייה (לא במקביל) לא שולחת שאילתת settings_str שוב", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    let settingsCalls = 0;
    mondayRequestMock.mockImplementation(async (q: string) => {
      if (isSettingsQuery(q)) {
        settingsCalls++;
        return labelSettings({ "1": "הושלם" }); // "לא רלוונטי" חסרה — לא חד-משמעי
      }
      return EMPTY_ITEMS_PAGE;
    });

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    await fetchProjectStageTasks("111");
    await fetchProjectStageTasks("222"); // ברצף, לא במקביל — בודק cache, לא רק single-flight

    expect(settingsCalls).toBe(1);
    const itemQueries = mondayRequestMock.mock.calls.map(([q]: [string]) => q).filter(isItemsPageQuery);
    expect(itemQueries.every((q) => !q.includes("not_any_of"))).toBe(true);
  });
});

describe("STAGE_STATUS_SERVER_FILTER_ENABLED — fallback על כישלון השאילתה המסוננת", () => {
  it("השאילתה המסוננת נכשלת — fallback מבוקר לשאילתה המקורית, מצליחה", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    mondayRequestMock.mockImplementation(async (q: string) => {
      if (isSettingsQuery(q)) return labelSettings({ "1": "הושלם", "9": "לא רלוונטי" });
      if (q.includes("not_any_of")) throw new Error("Monday rejected the rule - simulated");
      return EMPTY_ITEMS_PAGE;
    });

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    const tasks = await fetchProjectStageTasks("111");

    expect(tasks).toEqual([]);
  });

  it("גם ה-fallback נכשל — השגיאה ממשיכה הלאה, לא נבלעת", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    mondayRequestMock.mockImplementation(async (q: string) => {
      if (isSettingsQuery(q)) return labelSettings({ "1": "הושלם", "9": "לא רלוונטי" });
      throw new Error("Monday down - simulated");
    });

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    await expect(fetchProjectStageTasks("111")).rejects.toThrow("Monday down");
  });
});

describe("STAGE_STATUS_SERVER_FILTER_ENABLED — נכונות התוצאה נשמרת", () => {
  it("סינון הלקוח הקיים עדיין פעיל — פריט 'הושלם' שחזר (לכאורה משרת שגוי) מסונן בלקוח כרגיל", async () => {
    const env = await freshEnv();
    env.STAGE_STATUS_SERVER_FILTER_ENABLED = true;
    const itemsResponse = {
      boards: [
        {
          items_page: {
            cursor: null,
            items: [
              { id: "a1", name: "פתוחה", column_values: [{ id: "color85__1", text: "בעבודה" }] },
              { id: "a2", name: "סגורה", column_values: [{ id: "color85__1", text: "הושלם" }] },
            ],
          },
        },
      ],
    };
    mondayRequestMock.mockImplementation(async (q: string) =>
      isSettingsQuery(q) ? labelSettings({ "1": "הושלם", "9": "לא רלוונטי" }) : itemsResponse,
    );

    const fetchProjectStageTasks = await freshFetchProjectStageTasks();
    const tasks = await fetchProjectStageTasks("111");

    expect(tasks.map((t) => t.itemId)).toEqual(["a1"]); // "a2" (הושלם) מסונן בלקוח, גם אם "דלף" מהשרת
  });
});
