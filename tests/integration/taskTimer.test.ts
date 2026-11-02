/**
 * מדידת זמן עבודה על משימות (Task Timer) — בדיקות אינטגרציה מול DB מקומי מבודד (tests/setup).
 * אפס Monday / AI / רשת. נוכחות אמיתית (ops/attendance.ts) — הטיימר נבדק מול הפונקציות האמיתיות שלה,
 * כולל סגירה רטרואקטיבית ותיקונים. תאריכים פיקטיביים ב-2030.
 */

import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/db.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { buildMessageIdempotencySeed } from "../../src/ops/attendanceEngine.js";
import { checkAttendanceDayStart, reportBreakEnd, reportBreakStart, reportDayClose, requestAttendanceCorrection } from "../../src/ops/attendance.js";
import { insertEvent } from "../../src/db/repositories/attendanceEvents.js";
import {
  getActiveSegment,
  getTimerState,
  insertSegment,
  listSegmentsForDate,
} from "../../src/db/repositories/taskTimers.js";
import {
  confirmSwitch,
  getTimeReport,
  getTimerStatus,
  isTaskTimerEnabledForUser,
  resumeTimer,
  startTimer,
  stopTimer,
  stopTimerIfOnItem,
  sweepTaskTimers,
  takeActiveTimerReminder,
  type TimerTaskRef,
} from "../../src/ops/taskTimer.js";
import { buildTimerTools } from "../../src/ops/taskTimerTools.js";

const yochi = resolveUserByKey("yochi")!;
const dov = resolveUserByKey("dov")!;

const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });
const sid = (scope: string, id: string) => buildMessageIdempotencySeed({ scopeId: scope, channelMessageId: `${scope}-${id}` }); // channelMessageId גלובלי (UUID בפועל) — לכן כולל scope
const task = (id: string, name: string, project: string | null = "בלומינג"): TimerTaskRef => ({
  itemId: id,
  itemSource: "project_stage",
  taskName: name,
  projectId: project ? "p-" + project : null,
  projectName: project,
});
const A = task("1001", "תכניות קומה א");
const B = task("1002", "חזיתות");
const iso = (day: string, hhmm: string) => at(day, hhmm).toUTC().toISO()!;
const openDay = (user: typeof yochi, day: string, hhmm = "09:00") => checkAttendanceDayStart(user, at(day, hhmm));

beforeAll(() => {
  for (const t of ["task_timer_segments", "task_timer_state"]) db.prepare(`DELETE FROM ${t} WHERE user_key IN ('yochi','dov')`).run();
  for (const t of ["attendance_events", "attendance_days", "attendance_corrections"]) db.prepare(`DELETE FROM ${t} WHERE user_key IN ('yochi','dov')`).run();
});

describe("שער ההפעלה", () => {
  it("כבוי כברירת מחדל — גם ל-yochi", () => {
    expect(env.TASK_TIMER_ENABLED).toBe(false);
    expect(isTaskTimerEnabledForUser(yochi)).toBe(false);
  });
});

describe("התחלה, טיימר פעיל אחד, החלפה באישור", () => {
  const D = "2030-05-06";
  it("הפעלה — הנוסח המדויק; כפילות על אותה משימה — לא מייצרת מקטע", () => {
    openDay(yochi, D);
    const r = startTimer(yochi, A, at(D, "09:30"), sid("s1", "m1"));
    expect(r).toEqual({ ok: true, message: "מצוין! הפעלתי טיימר למשימה 'תכניות קומה א' בפרויקט 'בלומינג'." });
    const again = startTimer(yochi, A, at(D, "09:40"), sid("s1", "m2"));
    expect(again.ok).toBe(true);
    expect(again.message).toContain("כבר פועל");
    expect(listSegmentsForDate(yochi.key, D)).toHaveLength(1);
  });

  it("משימה אחרת — שואל, לא מחליף, ושומר החלפה ממתינה", () => {
    const r = startTimer(yochi, B, at(D, "10:00"), sid("s1", "m3"));
    expect(r.needsConfirmation).toBe(true);
    expect(r.message).toBe("כרגע פועל טיימר למשימה 'תכניות קומה א'. האם לעצור אותו ולהתחיל טיימר למשימה החדשה?");
    expect(getActiveSegment(yochi.key)!.itemId).toBe("1001");
    expect(getTimerState(yochi.key).pending?.itemId).toBe("1002");
  });

  it("הודעה שאינה אישור מפורש (לא / שאלה / ריקה) לא מחליפה", () => {
    for (const msg of ["לא", "רגע, מה עם התכניות?", "", "כן אבל קודם תגיד לי כמה זמן עבדתי?"]) {
      const r = confirmSwitch(yochi, msg, at(D, "10:05"), sid("s1", "x" + msg.length));
      expect(r.ok).toBe(false);
    }
    expect(getActiveSegment(yochi.key)!.itemId).toBe("1001");
  });

  it("אישור מפורש — הקודם נעצר (switched) והחדש מופעל; retry של אותה הודעה לא מכפיל", () => {
    const r = confirmSwitch(yochi, "כן", at(D, "10:08"), sid("s1", "m4"));
    expect(r.ok).toBe(true);
    expect(r.message).toBe("עצרתי את הטיימר של 'תכניות קומה א' (38 דקות). מצוין! הפעלתי טיימר למשימה 'חזיתות' בפרויקט 'בלומינג'.");
    const active = getActiveSegment(yochi.key)!;
    expect(active.itemId).toBe("1002");
    const retry = confirmSwitch(yochi, "כן", at(D, "10:09"), sid("s1", "m4"));
    expect(retry.ok).toBe(true);
    const segs = listSegmentsForDate(yochi.key, D);
    expect(segs).toHaveLength(2);
    expect(segs.filter((s) => s.endedAt === null)).toHaveLength(1);
    expect(segs[0]!.endReason).toBe("switched");
    expect(getTimerState(yochi.key).pending).toBeNull();
  });

  it("אישור בלי החלפה ממתינה, או אחרי תפוגה — נדחה", () => {
    expect(confirmSwitch(yochi, "כן", at(D, "11:00"), sid("s1", "m5")).ok).toBe(false);
    startTimer(yochi, A, at(D, "11:00"), sid("s1", "m6")); // שואל על A כשB פועל
    const late = confirmSwitch(yochi, "כן", at(D, "11:20"), sid("s1", "m7")); // 20 דק' > 10
    expect(late.ok).toBe(false);
    expect(late.message).toContain("פגה");
    expect(getActiveSegment(yochi.key)!.itemId).toBe("1002");
  });
});

describe("מניעת כפילות ומקביליות", () => {
  const D = "2030-05-07";
  it("אותה הודעה פעמיים → מקטע אחד", () => {
    openDay(yochi, D);
    startTimer(yochi, A, at(D, "09:30"), sid("s2", "m1"));
    startTimer(yochi, A, at(D, "09:30"), sid("s2", "m1"));
    expect(listSegmentsForDate(yochi.key, D)).toHaveLength(1);
  });

  it("שתי בקשות 'במקביל' על משימות שונות — אחת מופעלת, השנייה שואלת; ב-DB טיימר פעיל אחד", () => {
    const r1 = startTimer(yochi, B, at(D, "09:31"), sid("s2", "m2"));
    expect(r1.needsConfirmation).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM task_timer_segments WHERE user_key='yochi' AND ended_at IS NULL`).get()).toEqual({ n: 1 });
  });

  it("האינדקס החלקי חוסם טיימר שני גם כשעוקפים את הקוד (כתיבה גולמית)", () => {
    expect(() =>
      insertSegment({ userKey: yochi.key, workDate: D, itemId: "9", itemSource: "general", taskName: "x", projectId: null, projectName: null, startedAt: iso(D, "09:32"), idempotencyKey: "raw-dup" }),
    ).toThrow();
  });
});

describe("נוכחות: הפסקות", () => {
  const D = "2030-05-08";
  it("הפסקה בזמן אמת מנוכה; הטיימר ממשיך אחרי החזרה; אי אפשר להפעיל טיימר בהפסקה", () => {
    openDay(yochi, D);
    startTimer(yochi, A, at(D, "09:30"), sid("s3", "m1"));
    reportBreakStart(yochi, at(D, "11:00"), sid("s3", "m2"));
    expect(getActiveSegment(yochi.key)).not.toBeNull(); // הטיימר לא נסגר — החיתוך מוציא את ההפסקה
    expect(getTimerStatus(yochi, at(D, "11:10")).message).toContain("בהפסקה");
    expect(startTimer(yochi, B, at(D, "11:10"), sid("s3", "m3")).ok).toBe(false);
    reportBreakEnd(yochi, at(D, "11:30"), sid("s3", "m4"));
    const stop = stopTimer(yochi, at(D, "13:00"), "stopped", sid("s3", "m5"));
    expect(stop.message).toBe("עצרתי את הטיימר למשימה 'תכניות קומה א'. המקטע האחרון: 3 שעות; סה\"כ היום במשימה: 3 שעות.");
  });
});

describe("נוכחות: הפסקה שדווחה רטרואקטיבית", () => {
  const D = "2030-05-09";
  it("מנוכה גם ממקטע שכבר נסגר", () => {
    openDay(yochi, D);
    startTimer(yochi, A, at(D, "09:00"), sid("s4", "m1"));
    stopTimer(yochi, at(D, "12:00"), "stopped", sid("s4", "m2"));
    expect(getTimeReport(yochi, at(D, "12:30"), "today", undefined, undefined).message).toContain("3 שעות");

    const bs = requestAttendanceCorrection(yochi, { workDate: D, field: "break_start", newReportedForAtUtcIso: iso(D, "10:00"), insertNew: true, messageSeed: sid("s4", "m3") });
    const be = requestAttendanceCorrection(yochi, { workDate: D, field: "break_end", newReportedForAtUtcIso: iso(D, "10:20"), insertNew: true, messageSeed: sid("s4", "m4") });
    expect(bs.ok && be.ok).toBe(true);
    expect(getTimeReport(yochi, at(D, "12:30"), "today", undefined, undefined).message).toContain("2 שעות ו-40 דקות");
  });
});

describe("סגירת יום", () => {
  it("בזמן אמת — הטיימר נעצר לפי שעת הסיום, אין טיימר פעיל, אי אפשר להפעיל חדש", () => {
    const D = "2030-05-10";
    openDay(yochi, D);
    startTimer(yochi, A, at(D, "09:30"), sid("s5", "m1"));
    reportDayClose(yochi, at(D, "17:00"), sid("s5", "m2"));
    expect(getActiveSegment(yochi.key)).toBeNull();
    const seg = listSegmentsForDate(yochi.key, D)[0]!;
    expect(seg.endReason).toBe("day_close");
    expect(DateTime.fromISO(seg.endedAt!).toMillis()).toBe(at(D, "17:00").toMillis());
    expect(getTimeReport(yochi, at(D, "18:00"), "today", undefined, undefined).message).toContain("7 שעות ו-30 דקות");
    expect(startTimer(yochi, B, at(D, "17:30"), sid("s5", "m3")).ok).toBe(false);
  });

  it("רטרואקטיבית — יום שלא נסגר: הטיימר לא צובר זמן מומצא, ואחרי השלמת הסגירה נספר עד השעה המדווחת", () => {
    const D1 = "2030-05-11";
    const D2 = "2030-05-12";
    const S = task("3001", "שרטוט מפלס ייחודי", "ארליך");
    openDay(yochi, D1);
    startTimer(yochi, S, at(D1, "09:30"), sid("s6", "m1"));
    openDay(yochi, D2, "08:30"); // היום הקודם נשאר פתוח
    const r = startTimer(yochi, B, at(D2, "08:35"), sid("s6", "m2")); // לא דורש אישור — הישן stale
    expect(r.ok).toBe(true);
    const old = listSegmentsForDate(yochi.key, D1)[0]!;
    expect(old.endReason).toBe("stale");
    expect(getTimeReport(yochi, at(D2, "09:00"), "task", "מפלס ייחודי", "all").message).toContain("0 דקות");

    const fix = requestAttendanceCorrection(yochi, { workDate: D1, field: "day_close", newReportedForAtUtcIso: iso(D1, "16:00"), messageSeed: sid("s6", "m3") });
    expect(fix.ok).toBe(true);
    expect(listSegmentsForDate(yochi.key, D1)[0]!.endReason).toBe("day_close");
    expect(getTimeReport(yochi, at(D2, "09:00"), "task", "מפלס ייחודי", "all").message).toContain("6 שעות ו-30 דקות");
    expect(getActiveSegment(yochi.key)!.itemId).toBe("1002"); // הטיימר של היום החדש לא נפגע
  });

  it("תיקון שעת הסגירה — מוקדם יותר מקצר, מאוחר יותר מאריך (לא נשאר 'תקוע' על הערך הישן)", () => {
    const D = "2030-05-13";
    openDay(yochi, D);
    startTimer(yochi, A, at(D, "09:30"), sid("s7", "m1"));
    reportDayClose(yochi, at(D, "17:00"), sid("s7", "m2"));
    const earlier = requestAttendanceCorrection(yochi, { workDate: D, field: "day_close", newReportedForAtUtcIso: iso(D, "15:00"), messageSeed: sid("s7", "m3") });
    expect(earlier.ok).toBe(true);
    expect(getTimeReport(yochi, at(D, "18:00"), "today", undefined, undefined).message).toContain("5 שעות ו-30 דקות");
    const later = requestAttendanceCorrection(yochi, { workDate: D, field: "day_close", newReportedForAtUtcIso: iso(D, "16:00"), messageSeed: sid("s7", "m4") });
    expect(later.ok).toBe(true);
    expect(getTimeReport(yochi, at(D, "18:00"), "today", undefined, undefined).message).toContain("6 שעות ו-30 דקות");
  });

  it("כשל ב-hook: מקטע נשאר פתוח על יום סגור — השעות עדיין נכונות, וה-sweep סוגר אותו לפי שעת הסיום", () => {
    const D = "2030-05-14";
    openDay(yochi, D);
    startTimer(yochi, A, at(D, "09:30"), sid("s8", "m1"));
    // מדמה "hook לא רץ": אירוע סגירה נכתב ישירות, בלי recomputeAndPersistDay.
    insertEvent({ userKey: yochi.key, workDate: D, eventType: "day_close", reportedForAt: iso(D, "16:00"), source: "chat_window", idempotencyKey: "raw-close-" + D });
    expect(getActiveSegment(yochi.key)).not.toBeNull(); // ה-hook לא רץ — המקטע עוד פתוח
    const r = sweepTaskTimers(at(D, "18:00"));
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    expect(getActiveSegment(yochi.key)).toBeNull();
    expect(getTimeReport(yochi, at(D, "18:00"), "today", undefined, undefined).message).toContain("6 שעות ו-30 דקות");
    const seg = listSegmentsForDate(yochi.key, D)[0]!;
    expect(DateTime.fromISO(seg.endedAt!).toMillis()).toBe(at(D, "16:00").toMillis());
  });
});

describe("עצירה, המשך, סימון בוצע", () => {
  const D = "2030-05-15";
  it("אין טיימר → הודעה ברורה; עצירה idempotent; המשך פותח מקטע חדש לאותה משימה", () => {
    openDay(yochi, D);
    expect(stopTimer(yochi, at(D, "09:00"), "stopped", sid("s9", "m0")).ok).toBe(false);
    expect(resumeTimer(yochi, at(D, "09:00"), sid("s9", "m00")).ok).toBe(false);
    startTimer(yochi, A, at(D, "09:30"), sid("s9", "m1"));
    const s1 = stopTimer(yochi, at(D, "10:30"), "stopped", sid("s9", "m2"));
    const s1retry = stopTimer(yochi, at(D, "10:45"), "stopped", sid("s9", "m2"));
    expect(s1.ok && s1retry.ok).toBe(true);
    expect(s1retry.message).toBe(s1.message);
    const res = resumeTimer(yochi, at(D, "11:00"), sid("s9", "m3"));
    expect(res.message).toContain("תכניות קומה א");
    stopTimer(yochi, at(D, "11:30"), "stopped", sid("s9", "m4"));
    expect(listSegmentsForDate(yochi.key, D)).toHaveLength(2);
    expect(getTimeReport(yochi, at(D, "12:00"), "task", "1001", "today").message).toContain("1 שעות ו-30 דקות");
  });

  it("סימון בוצע עוצר רק טיימר על אותו פריט", () => {
    startTimer(yochi, B, at(D, "12:00"), sid("s9", "m5"));
    expect(stopTimerIfOnItem(yochi.key, "1001", at(D, "12:10"))).toBeNull();
    expect(getActiveSegment(yochi.key)).not.toBeNull();
    expect(stopTimerIfOnItem(yochi.key, "1002", at(D, "12:30"))?.itemId).toBe("1002");
    expect(getActiveSegment(yochi.key)).toBeNull();
    expect(listSegmentsForDate(yochi.key, D).at(-1)!.endReason).toBe("done");
    expect(resumeTimer(yochi, at(D, "12:40"), sid("s9", "m6")).ok).toBe(true); // ממשיך את A (stopped), לא את B (done)
    expect(getActiveSegment(yochi.key)!.itemId).toBe("1001");
    stopTimer(yochi, at(D, "12:50"), "stopped", sid("s9", "m7"));
  });
});

describe("תזכורת (throttle 10 דקות) ושאלות", () => {
  const D = "2030-05-16";
  it("בלי טיימר — אין תזכורת; עם טיימר — פעם ב-10 דקות, ולא עוצרת כלום", () => {
    openDay(yochi, D);
    expect(takeActiveTimerReminder(yochi, at(D, "09:20"))).toBeNull();
    startTimer(yochi, A, at(D, "09:30"), sid("s10", "m1"));
    const first = takeActiveTimerReminder(yochi, at(D, "10:00"));
    expect(first).toBe("שים לב, עדיין פועל טיימר למשימה 'תכניות קומה א'. האם לעצור אותו?");
    expect(takeActiveTimerReminder(yochi, at(D, "10:05"))).toBeNull();
    expect(takeActiveTimerReminder(yochi, at(D, "10:11"))).toBe(first);
    expect(getActiveSegment(yochi.key)).not.toBeNull();
  });

  it("'על איזו משימה אני עובד' — מנוסח מהנתונים", () => {
    const s = getTimerStatus(yochi, at(D, "10:30"));
    expect(s.message).toContain("תכניות קומה א");
    expect(s.message).toContain("בפרויקט 'בלומינג'");
    expect(s.message).toContain("מאז 09:30");
  });
});

describe("דוחות לפי פרויקט ומשימה", () => {
  const D = "2030-05-17";
  it("פרויקט ומשימה נפרדים, ללא מידע של עובד אחר", () => {
    openDay(yochi, D);
    openDay(dov, D);
    const K = task("2001", "קורן — היתר", "קורן");
    startTimer(yochi, A, at(D, "09:00"), sid("s11", "a"));
    stopTimer(yochi, at(D, "10:00"), "stopped", sid("s11", "b"));
    startTimer(yochi, K, at(D, "10:00"), sid("s11", "c"));
    stopTimer(yochi, at(D, "10:30"), "stopped", sid("s11", "d"));
    startTimer(dov, A, at(D, "09:00"), sid("s11", "e")); // אותו פריט, עובד אחר — אינו נספר ליוכי
    expect(getTimeReport(yochi, at(D, "11:00"), "project", "בלומינג", "today").message).toContain("1 שעות");
    expect(getTimeReport(yochi, at(D, "11:00"), "project", "קורן", "today").message).toContain("30 דקות");
    expect(getTimeReport(yochi, at(D, "11:00"), "project", "קורן", "today").message).not.toContain("תכניות קומה");
    expect(getTimeReport(yochi, at(D, "11:00"), "task", "תכניות", "week").message).toContain("תכניות קומה א");
    expect(getTimeReport(yochi, at(D, "11:00"), "project", "לא קיים", "all").message).toContain("לא נמדד");
    expect(getTimeReport(yochi, at(D, "11:00"), "project", undefined, undefined).ok).toBe(false);
    expect(getActiveSegment(dov.key)!.itemId).toBe("1001");
    reportDayClose(dov, at(D, "12:00"), sid("s11", "f"));
    expect(getActiveSegment(dov.key)).toBeNull();
    expect(getTimeReport(yochi, at(D, "13:00"), "today", undefined, undefined).message).toContain("1 שעות ו-30 דקות");
  });
});

describe("תאריך יום-העבודה: UTC מול ישראל", () => {
  it("טיימר שהתחיל אחרי חצות בישראל (עדיין 'אתמול' ב-UTC) נרשם ליום הישראלי", () => {
    const D = "2030-03-12";
    openDay(yochi, D, "00:10"); // 22:10Z של ה-11/3
    const nowUtc = DateTime.fromISO("2030-03-11T22:30:00Z", { zone: "utc" });
    expect(startTimer(yochi, A, nowUtc, sid("s12", "a")).ok).toBe(true);
    const seg = getActiveSegment(yochi.key)!;
    expect(seg.workDate).toBe(D);
    expect(DateTime.fromISO(seg.startedAt).toMillis()).toBe(nowUtc.toMillis());
    // עצירה כשהשעון נתון ב-UTC — אותו יום-נוכחות, 90 דקות אפקטיביות
    const stop = stopTimer(yochi, DateTime.fromISO("2030-03-12T00:00:00Z", { zone: "utc" }), "stopped", sid("s12", "b"));
    expect(stop.message).toContain("1 שעות ו-30 דקות");
  });
});

describe("כלי הצ'אט", () => {
  it("timer_start דוחה מזהה לא תקין ומשימה שאינה ברשימת העובד; אישור נבדק מול ההודעה האחרונה", async () => {
    const D = "2030-05-20";
    openDay(yochi, D);
    const texts: string[] = [];
    const mk = (latest: string, seed: string) =>
      buildTimerTools(yochi, {
        now: at(D, "09:30"),
        messageSeed: sid("s13", seed),
        latestUserMessage: latest,
        resolveTask: async (id) => (id === "1001" ? A : id === "1002" ? B : null),
        onResult: (_t, r) => texts.push(r.message),
      });
    const byName = (tools: ReturnType<typeof mk>, n: string) => tools.find((t) => t.name === n)!;

    expect((await byName(mk("מתחיל", "a"), "timer_start").run({ itemId: "item_abc" }) as { ok: boolean }).ok).toBe(false);
    expect((await byName(mk("מתחיל", "b"), "timer_start").run({ itemId: "999" }) as { ok: boolean }).ok).toBe(false);
    expect((await byName(mk("מתחיל", "c"), "timer_start").run({ itemId: "1001" }) as { ok: boolean }).ok).toBe(true);
    const ask = (await byName(mk("עכשיו אני על החזיתות", "d"), "timer_start").run({ itemId: "1002" })) as { needsConfirmation?: boolean };
    expect(ask.needsConfirmation).toBe(true);
    // המודל "מאשר" בעצמו בלי שהעובד אישר — נחסם בקוד
    expect(((await byName(mk("מה עם החזיתות?", "e"), "timer_confirm_switch").run({})) as { ok: boolean }).ok).toBe(false);
    expect(getActiveSegment(yochi.key)!.itemId).toBe("1001");
    expect(((await byName(mk("כן", "f"), "timer_confirm_switch").run({})) as { ok: boolean }).ok).toBe(true);
    expect(getActiveSegment(yochi.key)!.itemId).toBe("1002");
    expect(texts.length).toBeGreaterThan(5);
  });
});
