/**
 * יישור טיימרים לסגירת יום נוכחות. מודול נפרד בכוונה (תלוי רק ב-repository + luxon, **לא** ב-attendance.ts)
 * כדי ש-attendance.ts יוכל לייבא אותו בלי מעגל תלויות עם taskTimer.ts (שמייבא את attendance.ts).
 *
 * זה "ניקיון" ולא מקור האמת של השעות: הזמן האפקטיבי נגזר תמיד בקריאה מחיתוך עם מקטעי הנוכחות
 * (taskTimerEngine.ts), ולכן גם אם הקריאה כאן נכשלה או לא רצה — שום חישוב שעות לא משתבש; נשאר לכל
 * היותר מקטע פתוח על יום סגור, שסריקת ה-sweep (taskTimer.sweepTaskTimers) סוגרת.
 */

import { DateTime } from "luxon";
import { markItemTimeDirty } from "./taskTimerSyncMark.js";
import {
  listSegmentsNeedingDayCloseAlignment,
  endSegment,
  realignSegmentEnd,
} from "../db/repositories/taskTimers.js";

const iso = (ms: number) => DateTime.fromMillis(ms, { zone: "utc" }).toISO()!;

/**
 * נקרא בכל פעם שיום נוכחות נגמר סגור (סגירה רגילה, סגירה רטרואקטיבית, או תיקון שמזיז את שעת הסגירה).
 *  • מקטע פתוח → נסגר בשעת הסגירה המדווחת (לא בשעת העיבוד); מקטע שהתחיל אחרי הסגירה → משך אפס.
 *  • מקטע שכבר נסגר בגלל סגירת יום, או סומן stale (טיימר שנשכח פתוח מיום שלא נסגר) → מיושר מחדש
 *    לשעת הסגירה העדכנית. כך תיקון רטרואקטיבי של שעת הסגירה — מוקדם או מאוחר יותר — נשאר מדויק.
 *  • מקטע שהעובד עצר בעצמו (stopped/done/switched) לא נוגעים בו; החיתוך בקריאה מטפל בו.
 * Idempotent. סינכרוני, בלי טרנזקציה משלו — נקרא גם מתוך runInTransaction של הנוכחות (אין BEGIN מקונן).
 * מחזיר כמה מקטעים עודכנו.
 */
export function alignTimersToDayClose(userKey: string, workDate: string, closedAtIso: string): number {
  const closeMs = DateTime.fromISO(closedAtIso).toMillis();
  let changed = 0;
  for (const seg of listSegmentsNeedingDayCloseAlignment(userKey, workDate)) {
    const startMs = DateTime.fromISO(seg.startedAt).toMillis();
    const targetIso = iso(Math.max(startMs, closeMs));
    if (seg.endedAt === null) {
      if (endSegment(seg.id, targetIso, "day_close", null)) {
        changed++;
        markItemTimeDirty(seg.itemId, seg.itemSource);
      }
    } else if (DateTime.fromISO(seg.endedAt).toMillis() !== DateTime.fromISO(targetIso).toMillis() || seg.endReason !== "day_close") {
      realignSegmentEnd(seg.id, targetIso, "day_close");
      changed++;
      markItemTimeDirty(seg.itemId, seg.itemSource);
    }
  }
  return changed;
}
