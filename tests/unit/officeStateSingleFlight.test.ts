/**
 * Single-flight ל-getOfficeState (src/ops/officeState.ts) — בקשות מקבילות כש-cache קר (TTL 3 דק')
 * צריכות לחלוק שליפה אחת של Monday (getReverseDependencyMap + fetchActiveProjects + משימות כל
 * חברי הצוות), לא לכפול אותה. ר' הדוח שקדם לשינוי הזה (office_overview קורא ל-runControlScan +
 * getOversightReport במקביל, ושניהם קוראים ל-getOfficeState בלי הגנת in-flight).
 *
 * Mock מלא ל-opsRead.js (fetchUserOpsTasks/fetchActiveProjects/getReverseDependencyMap) — אין
 * Monday/AI אמיתיים (גם לו היה, networkGuard ב-tests/setup חוסם). vi.resetModules() + import
 * דינמי בכל בדיקה כדי שה-cache/inFlight המודולריים של officeState.ts יתחילו נקיים בכל פעם — אין
 * דרך חיצונית לאפס אותם (ובכוונה: לא הוספנו אחת, ר' דרישה לא להוסיף תשתית).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEAM_DIRECTORY } from "../../src/identity/index.js";
import type { OpsTask, ProjectMeta, DependentRef } from "../../src/integrations/monday/opsRead.js";

const { fetchUserOpsTasksMock, fetchActiveProjectsMock, getReverseDependencyMapMock } = vi.hoisted(() => ({
  fetchUserOpsTasksMock: vi.fn(),
  fetchActiveProjectsMock: vi.fn(),
  getReverseDependencyMapMock: vi.fn(),
}));

vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchUserOpsTasks: fetchUserOpsTasksMock,
    fetchActiveProjects: fetchActiveProjectsMock,
    getReverseDependencyMap: getReverseDependencyMapMock,
  };
});

const EXPECTED_MEMBER_COUNT = TEAM_DIRECTORY.filter((m) => m.mondayUserId).length; // 5 (כל הצוות חוץ מגולדי)

async function freshGetOfficeState() {
  const mod = await import("../../src/ops/officeState.js");
  return mod.getOfficeState;
}

beforeEach(() => {
  fetchUserOpsTasksMock.mockReset();
  fetchActiveProjectsMock.mockReset();
  getReverseDependencyMapMock.mockReset();
  fetchActiveProjectsMock.mockResolvedValue([] as ProjectMeta[]);
  getReverseDependencyMapMock.mockResolvedValue(new Map<string, DependentRef[]>());
  vi.resetModules();
});

describe("single-flight — getOfficeState", () => {
  it("שתי קריאות מקבילות כש-cache קר גורמות לשליפת Monday אחת, לא שתיים", async () => {
    fetchUserOpsTasksMock.mockResolvedValue([] as OpsTask[]);
    const getOfficeState = await freshGetOfficeState();

    const [s1, s2] = await Promise.all([getOfficeState(), getOfficeState()]);

    expect(s1).toBe(s2); // אותו אובייקט בדיוק — שליפה משותפת
    expect(fetchUserOpsTasksMock).toHaveBeenCalledTimes(EXPECTED_MEMBER_COUNT); // לא פי 2
    expect(getReverseDependencyMapMock).toHaveBeenCalledTimes(1);
    expect(fetchActiveProjectsMock).toHaveBeenCalledTimes(1);
  });

  it("כישלון מנקה את ה-in-flight ומאפשר ניסיון חוזר מוצלח", async () => {
    let shouldFail = true;
    fetchUserOpsTasksMock.mockImplementation(() =>
      shouldFail ? Promise.reject(new Error("Monday down - בדיקה")) : Promise.resolve([] as OpsTask[]),
    );
    const getOfficeState = await freshGetOfficeState();

    await expect(getOfficeState()).rejects.toThrow("Monday down");

    // אם ה-in-flight לא היה מתנקה בכישלון, הקריאה הבאה הייתה חוזרת על אותה הבטחה שנדחתה (אותה שגיאה),
    // ולא הייתה מבצעת ניסיון חדש בכלל.
    shouldFail = false;
    const state = await getOfficeState();
    expect(state.allTasks).toEqual([]);
    expect(state.perPerson).toHaveLength(EXPECTED_MEMBER_COUNT);
  });

  it("לא שומר Promise שנדחה כ-cache — קריאה שנייה אחרי כישלון מבצעת שליפה חדשה, לא חוזרת על הדחייה", async () => {
    fetchUserOpsTasksMock.mockRejectedValue(new Error("Monday down - בדיקה"));
    const getOfficeState = await freshGetOfficeState();

    await expect(getOfficeState()).rejects.toThrow("Monday down");
    const callsAfterFirstFailure = fetchUserOpsTasksMock.mock.calls.length;

    await expect(getOfficeState()).rejects.toThrow("Monday down");
    // קריאה שנייה ביצעה שליפה *חדשה* משלה (עוד קריאות Monday), לא רק חזרה על אותו promise שנדחה
    expect(fetchUserOpsTasksMock.mock.calls.length).toBeGreaterThan(callsAfterFirstFailure);
  });

  it("cache תקף (תוך 3 דק') מוחזר כרגיל, בלי שליפה חדשה", async () => {
    fetchUserOpsTasksMock.mockResolvedValue([] as OpsTask[]);
    const getOfficeState = await freshGetOfficeState();

    const s1 = await getOfficeState();
    fetchUserOpsTasksMock.mockClear();
    fetchActiveProjectsMock.mockClear();
    getReverseDependencyMapMock.mockClear();

    const s2 = await getOfficeState();
    expect(s2).toBe(s1);
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
    expect(fetchActiveProjectsMock).not.toHaveBeenCalled();
    expect(getReverseDependencyMapMock).not.toHaveBeenCalled();
  });

  it("force=true עוקף את ה-cache ומחזיר תוצאה חדשה, לא את התוצאה השמורה", async () => {
    fetchUserOpsTasksMock.mockResolvedValue([] as OpsTask[]);
    const getOfficeState = await freshGetOfficeState();

    const s1 = await getOfficeState(); // מחמם cache
    fetchUserOpsTasksMock.mockClear();

    const s2 = await getOfficeState(true);
    expect(fetchUserOpsTasksMock).toHaveBeenCalledTimes(EXPECTED_MEMBER_COUNT); // שליפה חדשה אמיתית
    expect(s2).not.toBe(s1); // לא הוחזרה התוצאה השמורה
  });

  it("אין race שמאפשר לשליפה ישנה (שהתחילה קודם) לדרוס cache שכתבה שליפה חדשה יותר", async () => {
    fetchUserOpsTasksMock.mockResolvedValue([] as OpsTask[]);

    // שולטים בתזמון דרך getReverseDependencyMap — נקראת פעם אחת בלבד בכל מחזור fetchOfficeState,
    // בלי סיבוכי concurrency-limit של mapPool (שם יש 3 בבת אחת, לא 5).
    type Deferred = { resolve: () => void };
    const cycleDeferreds: Deferred[] = [];
    getReverseDependencyMapMock.mockImplementation(
      () =>
        new Promise<Map<string, DependentRef[]>>((resolve) => {
          cycleDeferreds.push({ resolve: () => resolve(new Map()) });
        }),
    );

    const getOfficeState = await freshGetOfficeState();

    // שליפה "ישנה" — רגילה (force=false), מתחילה ראשונה ונרשמת כ-in-flight
    const oldPromise = getOfficeState();
    expect(cycleDeferreds).toHaveLength(1); // getOfficeState סינכרונית עד ה-await הראשון שלה
    const oldDeferred = cycleDeferreds[0]!;

    // רווח אמיתי כדי ש-startedAt של השליפה הבאה יהיה גדול יותר באופן מובטח (לא תלוי ברזולוציית שעון)
    await new Promise((r) => setTimeout(r, 5));

    // שליפה "חדשה" — force=true, לא מצטרפת ל-in-flight של הישנה, ומתחילה מאוחר יותר
    const newPromise = getOfficeState(true);
    expect(cycleDeferreds).toHaveLength(2);
    const newDeferred = cycleDeferreds[1]!;

    // ה"חדשה" מסיימת ראשונה (מהירה יותר בפועל, למרות שהתחילה מאוחר יותר)
    newDeferred.resolve();
    const newState = await newPromise;

    // ה"ישנה" מסיימת מאוחר יותר
    oldDeferred.resolve();
    const oldState = await oldPromise;
    expect(oldState).not.toBe(newState);

    // ה-cache חייב להישאר על newState (שהתחילה מאוחר יותר) — לא נדרס ע"י oldState שהגיע מאוחר יותר בזמן-אמת
    fetchUserOpsTasksMock.mockClear();
    getReverseDependencyMapMock.mockClear();
    fetchActiveProjectsMock.mockClear();
    const cached = await getOfficeState();
    expect(cached).toBe(newState);
    expect(getReverseDependencyMapMock).not.toHaveBeenCalled(); // הוכחה שזה הגיע מה-cache, לא משליפה שלישית
  });

  it("timestamp זהה (Date.now קפוא) — שליפה ישנה עדיין לא דורסת cache שכתבה שליפה חדשה יותר", async () => {
    // רזולוציית Date.now() היא אלפית שנייה — שתי קריאות ברצף סינכרוני (בלי await ביניהן) יכולות
    // לקבל את אותו timestamp בדיוק. ה-cache משתמש במונה generation מונוטוני (לא ב-Date.now()) בדיוק
    // כדי שהתרחיש הזה לא יישבר: קפאת השעון כאן מדמה אותו במדויק, בלי להסתמך על תזמון אמיתי.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      fetchUserOpsTasksMock.mockResolvedValue([] as OpsTask[]);

      type Deferred = { resolve: () => void };
      const cycleDeferreds: Deferred[] = [];
      getReverseDependencyMapMock.mockImplementation(
        () =>
          new Promise<Map<string, DependentRef[]>>((resolve) => {
            cycleDeferreds.push({ resolve: () => resolve(new Map()) });
          }),
      );

      const getOfficeState = await freshGetOfficeState();

      // שליפה "ישנה" — רגילה, מתחילה ראשונה (generation 1), עדיין אותו Date.now() קפוא
      const oldPromise = getOfficeState();
      expect(cycleDeferreds).toHaveLength(1);
      const oldDeferred = cycleDeferreds[0]!;

      // שליפה "חדשה" — force=true, generation 2, *בלי* להזיז את השעון בכלל (אותו Date.now() בדיוק)
      const newPromise = getOfficeState(true);
      expect(cycleDeferreds).toHaveLength(2);
      const newDeferred = cycleDeferreds[1]!;

      // ה"חדשה" מסיימת ראשונה
      newDeferred.resolve();
      const newState = await newPromise;

      // ה"ישנה" מסיימת מאוחר יותר — חייבת להיחסם ע"י generation, לא ע"י Date.now() (שזהה לשתיהן)
      oldDeferred.resolve();
      const oldState = await oldPromise;
      expect(oldState).not.toBe(newState);

      const cached = await getOfficeState();
      expect(cached).toBe(newState);
    } finally {
      vi.useRealTimers();
    }
  });
});
