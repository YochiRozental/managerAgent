/**
 * מדידת זמן על משימות — מנוע טהור (taskTimerEngine.ts): חיתוך מקטע טיימר עם מקטעי הנוכחות,
 * הפסקות, יום פתוח/סגור, ותאריך יום-העבודה מול UTC ואזור הזמן של ישראל (כולל מעבר שעון קיץ).
 */

import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { AttendanceEventLike } from "../../src/ops/attendanceEngine.js";
import { effectiveMs, formatDuration, msToMinutes, overlapMs, workDateForInstant, workIntervals } from "../../src/ops/taskTimerEngine.js";

const ZONE = "Asia/Jerusalem";
/** שעה מקומית (ישראל) → UTC ISO. */
const L = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}:00`, { zone: ZONE }).toUTC().toISO()!;
let seq = 0;
const ev = (eventType: AttendanceEventLike["eventType"], iso: string): AttendanceEventLike => ({ id: ++seq, eventType, reportedForAt: iso, sequenceNo: seq });
const min = (ms: number) => msToMinutes(ms);

describe("workIntervals", () => {
  const D = "2030-03-11";

  it("יום סגור: מקטעי העבודה בלי ההפסקה", () => {
    const events = [ev("day_open", L(D, "09:00")), ev("break_start", L(D, "12:00")), ev("break_end", L(D, "12:30")), ev("day_close", L(D, "17:00"))];
    const w = workIntervals(events, L(D, "20:00"));
    expect(w).toHaveLength(2);
    expect(min(w[0]!.endMs - w[0]!.startMs)).toBe(180);
    expect(min(w[1]!.endMs - w[1]!.startMs)).toBe(270);
  });

  it("יום פתוח: המקטע הפתוח נסגר וירטואלית ב-asOf (ולא אחריו)", () => {
    const events = [ev("day_open", L(D, "09:00"))];
    const w = workIntervals(events, L(D, "11:00"));
    expect(w).toHaveLength(1);
    expect(min(w[0]!.endMs - w[0]!.startMs)).toBe(120);
  });

  it("יום בהפסקה: ההפסקה הפתוחה לא נספרת", () => {
    const events = [ev("day_open", L(D, "09:00")), ev("break_start", L(D, "10:00"))];
    const w = workIntervals(events, L(D, "11:00"));
    expect(w.reduce((s, i) => s + (i.endMs - i.startMs), 0) / 60000).toBe(60);
  });

  it("asOf מוקדם מהאירוע האחרון לא משבש (לא מקצר ולא מקפל)", () => {
    const events = [ev("day_open", L(D, "09:00")), ev("break_start", L(D, "10:00"))];
    const w = workIntervals(events, L(D, "09:30"));
    expect(w.reduce((s, i) => s + (i.endMs - i.startMs), 0) / 60000).toBe(60);
  });

  it("אין אירועים בכלל: אין זמן עבודה", () => {
    expect(workIntervals([], L(D, "11:00"))).toEqual([]);
  });
});

describe("effectiveMs — חיתוך מקטע טיימר מול הנוכחות", () => {
  const D = "2030-03-11";
  const events = [ev("day_open", L(D, "09:00")), ev("break_start", L(D, "12:00")), ev("break_end", L(D, "12:30")), ev("day_close", L(D, "17:00"))];
  const work = workIntervals(events, L(D, "23:00"));

  it("מקטע שחוצה הפסקה — ההפסקה מנוכה", () => {
    expect(min(effectiveMs({ startedAt: L(D, "11:00"), endedAt: L(D, "13:00") }, work, L(D, "23:00")))).toBe(90);
  });

  it("מקטע שלם בתוך הפסקה — אפס", () => {
    expect(effectiveMs({ startedAt: L(D, "12:05"), endedAt: L(D, "12:25") }, work, L(D, "23:00"))).toBe(0);
  });

  it("מקטע שנשאר פתוח אחרי שעת הסיום — נחתך בסיום, לא ב-asOf", () => {
    expect(min(effectiveMs({ startedAt: L(D, "16:00"), endedAt: null }, work, L(D, "23:00")))).toBe(60);
  });

  it("מקטע שהתחיל אחרי הסיום — אפס; מקטע הפוך (סיום לפני התחלה) — אפס, לא שלילי", () => {
    expect(effectiveMs({ startedAt: L(D, "18:00"), endedAt: L(D, "19:00") }, work, L(D, "23:00"))).toBe(0);
    expect(effectiveMs({ startedAt: L(D, "14:00"), endedAt: L(D, "13:00") }, work, L(D, "23:00"))).toBe(0);
  });

  it("הפסקה שדווחה רטרואקטיבית (תיקון) מנוכה גם ממקטע שכבר נסגר", () => {
    const withRetroBreak = [...events, ev("break_start", L(D, "14:00")), ev("break_end", L(D, "14:20"))];
    const w = workIntervals(withRetroBreak, L(D, "23:00"));
    expect(min(effectiveMs({ startedAt: L(D, "13:00"), endedAt: L(D, "15:00") }, w, L(D, "23:00")))).toBe(100);
  });

  it("סגירת יום שתוקנה אחורה — מקטע שנסגר לפני התיקון נחתך לשעה המתוקנת", () => {
    const corrected = [ev("day_open", L(D, "09:00")), ev("day_close", L(D, "15:00"))];
    const w = workIntervals(corrected, L(D, "23:00"));
    expect(min(effectiveMs({ startedAt: L(D, "14:00"), endedAt: L(D, "17:00") }, w, L(D, "23:00")))).toBe(60);
  });

  it("overlapMs: מקטעי עבודה צמודים לא נספרים פעמיים", () => {
    expect(overlapMs({ startMs: 0, endMs: 100 }, [{ startMs: 0, endMs: 50 }, { startMs: 50, endMs: 100 }])).toBe(100);
  });
});

describe("תאריך יום-העבודה: UTC מול ישראל", () => {
  it("23:30 UTC בחורף (UTC+2) הוא כבר היום הבא בישראל", () => {
    expect(workDateForInstant("2030-03-11T22:30:00.000Z", ZONE)).toBe("2030-03-12");
    expect(workDateForInstant("2030-03-11T21:59:00.000Z", ZONE)).toBe("2030-03-11");
  });

  it("בקיץ (UTC+3) הגבול זז לשעה 21:00 UTC", () => {
    expect(workDateForInstant("2030-07-10T20:59:00.000Z", ZONE)).toBe("2030-07-10");
    expect(workDateForInstant("2030-07-10T21:00:00.000Z", ZONE)).toBe("2030-07-11");
  });

  it("מעבר לשעון קיץ: הלילה 'קצר' בשעה — משך מקטע נמדד בזמן אמיתי (UTC), לא בהפרש שעון קיר", () => {
    // ישראל 2030: קיץ מתחיל בשישי שלפני יום ראשון האחרון של מרץ (29/3). 02:00→03:00.
    const start = DateTime.fromISO("2030-03-28T22:00:00", { zone: ZONE }).toUTC().toISO()!;
    const end = DateTime.fromISO("2030-03-29T08:00:00", { zone: ZONE }).toUTC().toISO()!;
    const work = [{ startMs: DateTime.fromISO(start).toMillis(), endMs: DateTime.fromISO(end).toMillis() }];
    // שעון הקיר מראה 10 שעות, אבל עברו 9 שעות אמיתיות.
    expect(min(effectiveMs({ startedAt: start, endedAt: end }, work, end))).toBe(9 * 60);
  });

  it("שעון קיץ מסתיים: הלילה ארוך בשעה", () => {
    const start = DateTime.fromISO("2030-10-26T22:00:00", { zone: ZONE }).toUTC().toISO()!;
    const end = DateTime.fromISO("2030-10-27T08:00:00", { zone: ZONE }).toUTC().toISO()!;
    const work = [{ startMs: DateTime.fromISO(start).toMillis(), endMs: DateTime.fromISO(end).toMillis() }];
    expect(min(effectiveMs({ startedAt: start, endedAt: end }, work, end))).toBe(11 * 60);
  });
});

describe("formatDuration", () => {
  it("ניסוח עברי כמו הנוכחות", () => {
    expect(formatDuration(45)).toBe("45 דקות");
    expect(formatDuration(120)).toBe("2 שעות");
    expect(formatDuration(95)).toBe("1 שעות ו-35 דקות");
  });
});
