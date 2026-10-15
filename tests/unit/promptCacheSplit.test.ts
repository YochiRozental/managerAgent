/**
 * ניסוי Prompt Caching (2026-10-14) — buildWebPromptCacheSplit (src/ai/prompt.ts).
 *
 * המטרה: להוכיח *אוטומטית*, לא רק בעין, ש-הפיצול (cacheable+volatile) לא משנה אות אחת, לא מילה
 * אחת, ולא סדר אחד מההוראות הקיימות — רק את המיקום של שורת התאריך/שעה. אם זה אי-פעם ייכשל, זה
 * אומר שמשהו בתוכן ההוראות (לא רק המיקום) השתנה — כשל אמיתי, לא "לעדכן את ה-reference".
 *
 * דאטה-תאריך: buildWebPrompt ו-buildWebPromptCacheSplit קוראים ל-DateTime.now() באופן עצמאי,
 * מילישניות זה מזה — משווים אחרי נרמול הספרות (כמו tests/unit/sharedPrompt.test.ts's
 * normalizeTimestamps), לא משוואת-מחרוזת גולמית.
 */

import { describe, expect, it } from "vitest";
import { buildWebPromptCacheSplit } from "../../src/ai/prompt.js";
import { systemPrompt as webSystemPrompt } from "../../src/ops/chat.js";
import { resolveUserByKey, type IdentifiedUser } from "../../src/identity/index.js";
import type { LoopContext } from "../../src/ops/loopReply.js";
import { applyPromptCaching } from "../../src/ai/providers/anthropic.js";

function normalizeTimestamps(s: string): string {
  return s
    .replace(/\d{2}\/\d{2}\/\d{4}/g, "<DATE>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
    .replace(/\b\d{2}:\d{2}\b/g, "<TIME>");
}

const ABOUT: LoopContext = {
  itemId: "123",
  source: "general",
  findingKey: "k1",
  taskName: "התכניות של בלומינג",
  currentDueDateISO: "2026-10-20",
};

/** משחזר את הפלט המלא (סדר מקורי: שורה0, dateLine, שאר ההוראות) מתוך הפיצול. */
function reconstructInOriginalOrder(split: { cacheable: string; volatile: string }): string {
  const cacheableLines = split.cacheable.split("\n");
  return [cacheableLines[0]!, split.volatile, ...cacheableLines.slice(1)].join("\n");
}

describe("buildWebPromptCacheSplit — שקילות מלאה ל-systemPrompt (ללא שינוי תוכן/סדר הוראות)", () => {
  const roles: Array<[string, boolean]> = [
    ["moti", false],
    ["dov", false],
    ["ruchama", false],
    ["yochi", false],
  ];

  for (const [key] of roles) {
    it(`${key}: cacheable+volatile משוחזרים לסדר המקורי = בדיוק systemPrompt(user) הרגיל`, () => {
      const user = resolveUserByKey(key)!;
      const full = normalizeTimestamps(webSystemPrompt(user));
      const split = buildWebPromptCacheSplit(user);
      const reconstructed = normalizeTimestamps(reconstructInOriginalOrder(split));
      expect(reconstructed).toBe(full);
    });
  }

  it("עם about (פנייה יזומה) — גם כן שקילות מלאה, ה-about מופיע ב-cacheable", () => {
    const user = resolveUserByKey("dov")!;
    const full = normalizeTimestamps(webSystemPrompt(user, ABOUT));
    const split = buildWebPromptCacheSplit(user, ABOUT);
    expect(normalizeTimestamps(reconstructInOriginalOrder(split))).toBe(full);
    expect(split.cacheable).toContain("התכניות של בלומינג"); // ה-about הוא הוראה קבועה-לבקשה-הזו, לא "משתנה בכל דקה"
  });

  it("volatile מכיל *רק* את שורת התאריך/שעה — לא הוראות", () => {
    const user = resolveUserByKey("dov")!;
    const { volatile } = buildWebPromptCacheSplit(user);
    expect(volatile).toMatch(/^היום .+, השעה \d{2}:\d{2} /);
    expect(volatile.split("\n")).toHaveLength(1);
  });

  it("cacheable לא מכיל את שורת התאריך/שעה (היחיד שמשתנה כל דקה)", () => {
    const user = resolveUserByKey("dov")!;
    const { cacheable } = buildWebPromptCacheSplit(user);
    expect(cacheable).not.toMatch(/השעה \d{2}:\d{2}/);
  });

  it("בידוד בין משתמשים: dov (project_manager) ו-ruchama (planner) מקבלים cacheable *שונה*", () => {
    // מוכיח שהמטמון לא "משותף בטעות" — פרפיקס שונה = cache entry שונה, בלי שום מנגנון נוסף.
    const dov = resolveUserByKey("dov")!;
    const ruchama = resolveUserByKey("ruchama")!;
    const splitDov = buildWebPromptCacheSplit(dov);
    const splitRuchama = buildWebPromptCacheSplit(ruchama);
    expect(splitDov.cacheable).not.toBe(splitRuchama.cacheable);
  });

  it("יציבות: שתי קריאות עבור אותו משתמש/about מייצרות cacheable זהה (prefix stability)", () => {
    const user = resolveUserByKey("dov")!;
    const a = buildWebPromptCacheSplit(user, ABOUT);
    const b = buildWebPromptCacheSplit(user, ABOUT);
    expect(a.cacheable).toBe(b.cacheable);
  });

  it("הרשאה משפיעה על cacheable (מוטי עם view:all_work מקבל הוראת בקרה שדוב לא מקבל)", () => {
    const moti = resolveUserByKey("moti")!;
    const dov = resolveUserByKey("dov")!;
    expect(buildWebPromptCacheSplit(moti).cacheable).toContain("ראייה על כל המשרד");
    expect(buildWebPromptCacheSplit(dov).cacheable).not.toContain("ראייה על כל המשרד");
  });

  /**
   * audit (2026-10-15): הבדיקות למעלה מוכיחות ש-buildWebPromptCacheSplit's שני השדות, כשמשוחזרים
   * ע"י reconstructInOriginalOrder (helper מקומי שמחזיר ידנית את dateLine למיקומו), שווים ל-
   * systemPrompt המלא. זה **לא** מה ש-Anthropic בפועל מקבלת — applyPromptCaching (anthropic.ts)
   * מצרפת cacheable+volatile *בסדר הזה* (לא בחזרה למיקום המקורי) ו*בלי* מפריד משלה. הבדיקה הזו
   * בודקת את ה-wire format האמיתי: שום הוראה לא אבדה (כל השורות הקבועות מופיעות), התאריך מופיע
   * פעם אחת, ואין הדבקה-תו-בתו בין סוף ההוראות לתחילת התאריך (ר' התיקון ב-anthropic.ts).
   */
  it("wire format אמיתי (buildWebPromptCacheSplit → applyPromptCaching, בלי מרכיב-בדיקה שמתקן בעצמו): ההוראות נשמרות, התאריך מופרד", () => {
    const user = resolveUserByKey("dov")!;
    const split = buildWebPromptCacheSplit(user);
    const { system } = applyPromptCaching("לא בשימוש", undefined, {
      cacheableSystem: split.cacheable,
      volatileSystemSuffix: split.volatile,
    });
    const blocks = system as { text: string }[];
    const wireText = blocks.map((b) => b.text).join("");

    // כל שורה קבועה (לא ריקה) מההוראות המקוריות מופיעה ב-wire text — אין אובדן תוכן.
    const originalLines = split.cacheable.split("\n").filter((l) => l.trim().length > 0);
    for (const line of originalLines) {
      expect(wireText).toContain(line);
    }
    // התאריך מופיע, בדיוק פעם אחת, ולא דבוק לתו שלפניו (יש "\n\n" ממש לפניו).
    expect(wireText.split(split.volatile)).toHaveLength(2);
    expect(wireText).toContain(`\n\n${split.volatile}`);
  });
});
