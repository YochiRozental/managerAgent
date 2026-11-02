/**
 * חישוב זמן אפקטיבי מצטבר — משותף לדוחות הצ'אט (taskTimer.ts) ולסנכרון ל-Monday (taskTimerSync.ts).
 * הדיוק המלא נשמר ונחשב במילישניות; רק הערך שמוצג/נכתב ל-Monday מעוגל (hoursFromMs).
 */

import { getEffectiveAttendance } from "./attendance.js";
import { effectiveMs, workIntervals, type Interval } from "./taskTimerEngine.js";
import { listClosedSegmentsForItem } from "../db/repositories/taskTimers.js";

/** מקטעי העבודה של יום נוכחות פר-עובד (מטמון פר-קריאה). */
export function makeIntervalsResolver(userKey: string, asOfIso: string): (workDate: string) => Interval[] {
  const cache = new Map<string, Interval[]>();
  return (workDate) => {
    let v = cache.get(workDate);
    if (!v) {
      v = workIntervals(getEffectiveAttendance(userKey, workDate).events, asOfIso);
      cache.set(workDate, v);
    }
    return v;
  };
}

/**
 * סכום הזמן האפקטיבי (ms) על פריט: כל העובדים, כל הימים, מקטעים **סגורים** בלבד (טיימר פעיל לא נכלל
 * עד שנעצר). כל מקטע נחתך מול מקטעי הנוכחות של העובד שלו באותו יום — בלי הפסקות, עד שעת הסגירה
 * המדווחת (גם אחרי תיקון רטרואקטיבי).
 */
export function computeItemTotalMs(itemId: string, asOfIso: string): number {
  const resolvers = new Map<string, (d: string) => Interval[]>();
  let total = 0;
  for (const seg of listClosedSegmentsForItem(itemId)) {
    let r = resolvers.get(seg.userKey);
    if (!r) {
      r = makeIntervalsResolver(seg.userKey, asOfIso);
      resolvers.set(seg.userKey, r);
    }
    total += effectiveMs(seg, r(seg.workDate), asOfIso);
  }
  return total;
}

/**
 * תצוגת HH:MM מהמילישניות המלאות (לא מהערך העשרוני המעוגל): עיגול לדקה הקרובה (30 שניות ומעלה = דקה),
 * שעות ללא איפוס מעל 24 ("25:00", "100:05"), אפס מוביל לשעות ולדקות. ערך לא תקין/שלילי → "00:00".
 */
export function formatHHMM(ms: number): string {
  const minutes = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** שעות עם שתי ספרות אחרי הנקודה — ההצגה ב-Monday בלבד; הדיוק המלא נשאר ב-SQLite. */
export function hoursFromMs(ms: number): number {
  return Math.round(ms / 36_000) / 100;
}
