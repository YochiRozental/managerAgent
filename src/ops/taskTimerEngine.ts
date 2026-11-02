/**
 * מדידת זמן עבודה על משימות — לוגיקה טהורה בלבד (בלי DB, בלי Monday), בדיוק כמו attendanceEngine.ts.
 *
 * עיקרון: הזמן האפקטיבי של מקטע-טיימר = החיתוך של [started_at, ended_at|asOf) עם *מקטעי העבודה*
 * של יום הנוכחות (attendanceEngine.computeDaySummary, אחרי תיקונים). לכן:
 *   • הפסקות — גם כאלה שדווחו רטרואקטיבית — לא נספרות, בלי שום עדכון של המקטעים עצמם;
 *   • זמן אחרי סגירת היום (גם סגירה שתוקנה אחורה) לא נספר;
 *   • טיימר שנשאר פתוח בטעות לא יכול "לצבור" זמן מעבר לשעת הסיום המדווחת.
 * כל החישוב על מילישניות UTC (DateTime.toMillis) — אין תלות באזור זמן ובשעון קיץ. אזור הזמן נכנס
 * רק ב-workDateForInstant, שקובע לאיזה יום-נוכחות מקטע שייך (תאריך ישראל של ההתחלה).
 */

import { DateTime } from "luxon";
import { computeDaySummary, statusAfter, type AttendanceEventLike } from "./attendanceEngine.js";

export interface Interval {
  startMs: number;
  endMs: number;
}

/** מקטע טיימר גולמי כפי שנשמר: endedAt=null ⇔ פעיל. */
export interface RawSegment {
  startedAt: string;
  endedAt: string | null;
}

/** תאריך יום-העבודה (YYYY-MM-DD) של רגע נתון, לפי אזור הזמן — לא לפי UTC. */
export function workDateForInstant(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(zone).toISODate()!;
}

/**
 * מקטעי העבודה של יום נוכחות, כולל המקטע הפתוח (עד asOf) אם היום עדיין פתוח. יום פתוח נסגר
 * "וירטואלית" ב-asOf בלבד לצורך החישוב — לא נכתב לשום מקום. asOf לא יכול להיות לפני האירוע האחרון
 * (אחרת הסגירה הווירטואלית הייתה ממוינת לפני אירועים קיימים ומשבשת את החישוב).
 */
export function workIntervals(events: readonly AttendanceEventLike[], asOfIso: string): Interval[] {
  let effective = [...events];
  if (statusAfter(effective) !== "closed") {
    const lastMs = effective.reduce((m, e) => Math.max(m, DateTime.fromISO(e.reportedForAt).toMillis()), 0);
    const asOfMs = Math.max(DateTime.fromISO(asOfIso).toMillis(), lastMs);
    effective = [
      ...effective,
      { eventType: "day_close", reportedForAt: DateTime.fromMillis(asOfMs, { zone: "utc" }).toISO()!, sequenceNo: Number.MAX_SAFE_INTEGER },
    ];
  }
  return computeDaySummary(effective).segments.map((s) => ({
    startMs: DateTime.fromISO(s.startAt).toMillis(),
    endMs: DateTime.fromISO(s.endAt!).toMillis(),
  }));
}

/** מילישניות חפיפה בין מקטע לבין קבוצת מקטעי עבודה (שאינם חופפים זה לזה). */
export function overlapMs(seg: Interval, work: readonly Interval[]): number {
  if (seg.endMs <= seg.startMs) return 0;
  let total = 0;
  for (const w of work) {
    const s = Math.max(seg.startMs, w.startMs);
    const e = Math.min(seg.endMs, w.endMs);
    if (e > s) total += e - s;
  }
  return total;
}

/** משך אפקטיבי (ms) של מקטע טיימר מול מקטעי העבודה של היום שלו. פתוח → נספר עד asOf. */
export function effectiveMs(seg: RawSegment, work: readonly Interval[], asOfIso: string): number {
  const startMs = DateTime.fromISO(seg.startedAt).toMillis();
  const endMs = DateTime.fromISO(seg.endedAt ?? asOfIso).toMillis();
  return overlapMs({ startMs, endMs }, work);
}

export function msToMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** "N שעות ו-M דקות" — זהה ל-formatMinutes של הנוכחות, מקומי כדי לא ליצור תלות הפוכה. */
export function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} דקות`;
  if (m === 0) return `${h} שעות`;
  return `${h} שעות ו-${m} דקות`;
}
