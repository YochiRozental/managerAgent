/**
 * ה-router (בחירת FAST/SMART + החלטת fallback) — הועבר אחד-לאחד מ-scripts/test-model-router.ts
 * (18 בדיקות, הסקריפט הישן הוסר). לוגיקה טהורה.
 */

import { describe, expect, it } from "vitest";
import { chooseModelForTask, shouldEscalateToSmart, type RouteContext } from "../../src/ai/models.js";

function route(partial: Partial<RouteContext> & { latestMessage: string }) {
  return chooseModelForTask({
    useCase: "ops_chat",
    historyLength: 2,
    canSeeAllWork: false,
    ...partial,
  });
}

describe("פעולות פשוטות → FAST", () => {
  it("'בוקר טוב' → FAST", () => expect(route({ latestMessage: "בוקר טוב" }).tier).toBe("fast"));
  it("'כן' → FAST", () => expect(route({ latestMessage: "כן" }).tier).toBe("fast"));
  it("'בוקר טוב' מסומן trivial", () => expect(route({ latestMessage: "בוקר טוב" }).reason).toBe("trivial"));
  it("דיווח ביצוע → FAST", () => expect(route({ latestMessage: "סיימתי את התכניות של בלומינג" }).tier).toBe("fast"));
  it("'מה יש לי היום' → FAST", () => expect(route({ latestMessage: "מה יש לי היום?" }).tier).toBe("fast"));
  it("עדכון סטטוס → FAST", () => expect(route({ latestMessage: "תעדכן שהתחלתי לעבוד על ההגשה" }).tier).toBe("fast"));
  it("עובד רגיל 'מה תקוע' → FAST (אין ראיית כל-המשרד)", () =>
    expect(route({ latestMessage: "מה תקוע אצלי?", canSeeAllWork: false }).tier).toBe("fast"));
});

describe("פעולות מורכבות → SMART", () => {
  it("'תנתח' → SMART", () => expect(route({ latestMessage: "תנתח לי את מצב הפרויקט של סלונים" }).tier).toBe("smart"));
  it("'תכנן סדר עבודה' → SMART", () => expect(route({ latestMessage: "תכנן לי סדר עבודה למחר" }).tier).toBe("smart"));
  it("בחירה בין אפשרויות → SMART", () =>
    expect(route({ latestMessage: "מה עדיף — להתחיל ברישוי או בתכניות?" }).tier).toBe("smart"));
  it("בקשת המלצה → SMART", () => expect(route({ latestMessage: "תמליץ לי במה להתמקד השבוע" }).tier).toBe("smart"));
  it("מוטי 'מה תקוע במשרד' → SMART (שאלת בקרה־על)", () =>
    expect(route({ latestMessage: "מה תקוע במשרד?", canSeeAllWork: true }).tier).toBe("smart"));
  it("הודעה >220 תווים → SMART", () => expect(route({ latestMessage: "a".repeat(300) }).tier).toBe("smart"));
  it("שיחה עמוקה (14+) → SMART", () => expect(route({ latestMessage: "מה קורה פה?", historyLength: 20 }).tier).toBe("smart"));
});

describe("fallback FAST→SMART", () => {
  it("FAST נכשל בלי תופעות לוואי → מסלים", () =>
    expect(shouldEscalateToSmart({ attemptedTier: "fast", failed: true, sideEffectsCount: 0 })).toBe(true));
  it("FAST הצליח → לא מסלים (אין קריאת AI שנייה מיותרת)", () =>
    expect(shouldEscalateToSmart({ attemptedTier: "fast", failed: false, sideEffectsCount: 0 })).toBe(false));
  it("FAST נכשל אבל בוצעה כתיבה → לא מסלים (לא מכפילים פעולות)", () =>
    expect(shouldEscalateToSmart({ attemptedTier: "fast", failed: true, sideEffectsCount: 1 })).toBe(false));
  it("כבר רצנו SMART → אין הסלמה נוספת (אין retry loop)", () =>
    expect(shouldEscalateToSmart({ attemptedTier: "smart", failed: true, sideEffectsCount: 0 })).toBe(false));
});
