/**
 * אירוע 2026-10-19 (Commit 2dd0746): מסך לבן בפרודקשן — SyntaxError ב-<script> הראשי של
 * src/server/ui.html. הסיבה: תגובת JSDoc הכילה בטעות את התת-מחרוזת "reply_" + כוכבית + לוכסן
 * (סימן סגירת-תגובה ליטרלי בתוך הטקסט), שסגרה את ה-comment block מוקדם — השורות שאחריו (כולל
 * קוד אמיתי) נשארו מחוץ לתגובה ונפלו לשגיאת תחביר. tsc --noEmit לא תופס את זה בכלל — ui.html
 * הוא HTML, לא קובץ TypeScript, ושום בדיקה קיימת לא פענחה את ה-JS המוטבע בתוכו בפועל.
 *
 * הבדיקה הזו מחלצת כל <script> (בלי src=) מ-ui.html ומריצה אותו דרך vm.Script (פרסור תחביר
 * אמיתי של Node — בלי להרשים אותו: שום DOM/window, רק syntax check) — כדי שתקלה מהסוג הזה
 * (כל SyntaxError בקוד המוטבע, לא רק זה) תיתפס לפני פריסה, לא אחריה.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

const UI_HTML_PATH = resolve(import.meta.dirname, "../../src/server/ui.html");

function extractInlineScripts(html: string): string[] {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const scripts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) scripts.push(m[1]);
  return scripts;
}

describe("src/server/ui.html — תחביר JS של הסקריפטים המוטבעים", () => {
  it("יש לפחות סקריפט מוטבע אחד (לא רק קבצים חיצוניים — אחרת הבדיקה הזו לא בודקת כלום)", () => {
    const html = readFileSync(UI_HTML_PATH, "utf-8");
    expect(extractInlineScripts(html).length).toBeGreaterThan(0);
  });

  it("כל <script> מוטבע הוא JavaScript תקין (vm.Script — syntax check אמיתי, בלי להריץ). " +
     "זו הבדיקה שהייתה תופסת את אירוע 2026-10-19 (Commit 2dd0746) — '*/' מוטבע בתוך JSDoc סגר " +
     "את התגובה מוקדם והשאיר קוד אמיתי מחוץ להקשר תחבירי.", () => {
    const html = readFileSync(UI_HTML_PATH, "utf-8");
    const scripts = extractInlineScripts(html);
    for (const [i, code] of scripts.entries()) {
      expect(() => new Script(code, { filename: `ui.html-inline-script-${i + 1}.js` }), `סקריפט מוטבע #${i + 1}`).not.toThrow();
    }
  });
});
