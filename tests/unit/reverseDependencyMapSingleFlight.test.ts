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
