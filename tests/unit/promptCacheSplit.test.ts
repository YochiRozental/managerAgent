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
});
