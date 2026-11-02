/**
 * סימון פריטים ל"סנכרון מחדש" ל-Monday. מודול נפרד וקל (repository + env בלבד, בלי תלות בנוכחות) כדי
 * ש-attendance.ts / taskTimerDayClose.ts / taskTimer.ts יוכלו לייבא אותו בלי מעגל תלויות.
 *
 * כבוי לגמרי כש-TASK_TIMER_MONDAY_SYNC_ENABLED=false — אפס כתיבה לטבלת התור. כשהדגל מופעל, סנכרון
 * ההפעלה הראשון (backfillTaskTimerSync) מסמן את כל הפריטים הקיימים, כך שמה שקרה בזמן שהדגל היה כבוי
 * לא הולך לאיבוד. כל פונקציה כאן best-effort: כשל בסימון לעולם לא מכשיל עצירת טיימר/רישום נוכחות
 * (הנתונים ב-SQLite נשמרים, והסימון הבא / ה-backfill מתקן).
 */

import { env } from "../config/env.js";
import { listClosedItemsForDay } from "../db/repositories/taskTimers.js";
import { markDirty } from "../db/repositories/taskTimerSync.js";
import { logger } from "../utils/logger.js";

export function markItemTimeDirty(itemId: string, itemSource: string): void {
  if (!env.TASK_TIMER_MONDAY_SYNC_ENABLED) return;
  try {
    markDirty(itemId, itemSource);
  } catch (err) {
    logger.error({ err, itemId }, "סימון פריט לסנכרון זמן ל-Monday נכשל — ה-backfill בהפעלה הבאה ישלים");
  }
}

/**
 * כל הפריטים שיש להם מקטעים סגורים באותו (עובד, יום) — נקרא אחרי כל חישוב-מחדש של יום נוכחות, כולל
 * תיקון רטרואקטיבי של הפסקה/כניסה/יציאה: הסכום האפקטיבי שלהם עשוי להשתנות, והסנכרון כותב את הסכום
 * הכולל מחדש מ-SQLite.
 */
export function markDayItemsDirty(userKey: string, workDate: string): void {
  if (!env.TASK_TIMER_MONDAY_SYNC_ENABLED) return;
  try {
    for (const it of listClosedItemsForDay(userKey, workDate)) markDirty(it.itemId, it.itemSource);
  } catch (err) {
    logger.error({ err, userKey, workDate }, "סימון פריטי יום לסנכרון זמן ל-Monday נכשל — ה-backfill בהפעלה הבאה ישלים");
  }
}
