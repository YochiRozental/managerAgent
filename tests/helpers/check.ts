/**
 * עזר להעברת סקריפטי בדיקה ישנים (scripts/test-*.ts) ל-Vitest בלי לגעת בתנאים עצמם.
 *
 * הסקריפטים הישנים בנויים כ-`check(label, cond, extra?)` / `assert(cond, msg)` לאורך קוד רציף
 * עם await. כאן כל קריאה כזו נרשמת כ-`it` נפרד של Vitest, עם אותו תנאי בדיוק ואותה הודעת
 * כישלון. כך התרחישים, התנאים והכיסוי נשמרים אחד-לאחד, וכל תנאי מדווח בנפרד (כמו ✅/❌ בסקריפט).
 *
 * התנאי מחושב בזמן טעינת הקובץ (collection), כמו בסקריפט המקורי. חריגה לא צפויה בקוד הנבדק
 * מכשילה את הקובץ כולו — בדיוק כמו שהסקריפט הישן קרס עם exit 1.
 */

import { expect, it } from "vitest";

/** חתימת `check(label, cond, extra?)` מהסקריפטים הישנים. */
export function check(label: string, cond: boolean, extra = ""): void {
  it(label, () => {
    expect(cond, extra ? `${label} — ${extra}` : label).toBe(true);
  });
}

/** חתימת `assert(cond, msg)` מהסקריפטים הישנים. */
export function assert(cond: boolean, msg: string): void {
  check(msg, cond);
}
