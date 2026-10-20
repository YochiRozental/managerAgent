/**
 * "תזכורות נוכחות נראות כפולות" (audit 2026-10-19) — תזכורות אמיתיות לימים שונים (CAS exactly-once
 * פר-work_date, ר' attendanceReminderScheduler.ts) נראות זהות כי אין תאריך מובנה על ההתראה עצמה.
 *
 * הבדיקה הזו מכסה את שתי השכבות:
 *   1. תזכורת *חדשה* — context.workDate נשמר ב-DB מרגע היצירה (לא רק בטקסט body).
 *   2. תזכורת *ישנה* (context=NULL, כמו כל מה שנוצר לפני השינוי) — findWorkDateForReminder
 *      משחזר את ה-work_date הנכון בקריאה-בלבד, לפי התאמה מדויקת ל-reminder_sent_at; ומחזיר
 *      null (לא מנחש) כש-אין התאמה חד-משמעית — אפס/יותר משורה אחת.
 *
 * DB זמני מבודד (tests/setup/isolate.ts) — לא נוגע בנתוני נוכחות אמיתיים.
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { describe, expect, it, beforeEach } from "vitest";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/db.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { checkAttendanceDayStart, setAttendanceReminderTime } from "../../src/ops/attendance.js";
import { runAttendanceReminderTick } from "../../src/ops/attendanceReminderScheduler.js";
import { findWorkDateForReminder, getDay } from "../../src/db/repositories/attendanceDays.js";
import { listUnseenNotifications, addNotification } from "../../src/db/repositories/notifications.js";

const yochi = resolveUserByKey("yochi")!;
const dov = resolveUserByKey("dov")!;
const TEST_USERS = ["yochi", "dov"];

function cleanup(): void {
  const placeholders = TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_reminder_prefs WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM notifications WHERE user_key IN (${placeholders}) AND kind = 'attendance_reminder'`).run(...TEST_USERS);
}

beforeEach(() => cleanup());

const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });

describe("תזכורת חדשה — context.workDate נשמר מרגע היצירה", () => {
  it("נכתב ב-DB (לא רק בטקסט body), ותואם בדיוק את work_date האמיתי", async () => {
    const day = "2031-04-10";
    setAttendanceReminderTime(yochi, 14, 0);
    checkAttendanceDayStart(yochi, at(day, "09:00"));

    const sent = await runAttendanceReminderTick(at(day, "14:00"));
    expect(sent).toBeGreaterThanOrEqual(1);

    const notif = listUnseenNotifications(yochi.key).find((n) => n.kind === "attendance_reminder");
    expect(notif).toBeDefined();
    expect(notif!.context).toEqual({ workDate: day });
  });

  it("שני ימים שונים לאותו עובד מקבלים context.workDate שונה (לא נראים כמו הודעה משוכפלת)", async () => {
    setAttendanceReminderTime(yochi, 9, 0);
    const day1 = "2031-04-11";
    checkAttendanceDayStart(yochi, at(day1, "08:00"));
    await runAttendanceReminderTick(at(day1, "09:00"));
    const notif1 = listUnseenNotifications(yochi.key).find((n) => n.kind === "attendance_reminder");
    expect((notif1?.context as { workDate?: string } | null)?.workDate).toBe(day1);
    // סוגרים את היום כדי ש-היום הבא ייפתח נקי (כמו בשאר הבדיקות הקיימות באותו קובץ).
    db.prepare(`UPDATE attendance_days SET status='closed' WHERE user_key=? AND work_date=?`).run(yochi.key, day1);

    const day2 = "2031-04-12";
    checkAttendanceDayStart(yochi, at(day2, "08:00"));
    await runAttendanceReminderTick(at(day2, "09:00"));
    // הטיק של day2 מריץ גם את ה-reconciliation היזומה (audit "מחזור חיים" 2026-10-20) — day1
    // כבר status='closed' (אפילו בלי לעבור ב-recomputeAndPersistDay), אז התזכורת שלו נסגרת
    // אוטומטית כתופעת-לוואי נכונה; זה בדיוק התרחיש שהתיקון נועד לכסות, לא כפילות. נשארת רק day2.
    const notifs = listUnseenNotifications(yochi.key).filter((n) => n.kind === "attendance_reminder");
    const workDates = notifs.map((n) => (n.context as { workDate?: string } | null)?.workDate).sort();
    expect(workDates).toEqual([day2]);
  });
});

describe("findWorkDateForReminder — שחזור תאריך להתראה ישנה, בקריאה בלבד", () => {
  it("מתאמת user_key+reminder_sent_at במדויק להתראה 'ישנה' (context=NULL, כמו כל מה שנוצר לפני התיקון)", async () => {
    const day = "2031-04-13";
    setAttendanceReminderTime(yochi, 11, 0);
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "11:00"));

    const sentAt = getDay(yochi.key, day)?.reminderSentAt;
    expect(sentAt).not.toBeNull();

    // מדמים התראה "ישנה" — אותה created_at בדיוק (= reminder_sent_at), בלי context מובנה.
    db.exec(`DELETE FROM notifications WHERE user_key = '${yochi.key}' AND kind = 'attendance_reminder'`);
    db.prepare(
      `INSERT INTO notifications (user_key, kind, body, created_at) VALUES (?, 'attendance_reminder', 'שים לב, שעון הנוכחות שלך עדיין פעיל.', ?)`,
    ).run(yochi.key, sentAt);

    const found = findWorkDateForReminder(yochi.key, sentAt!);
    expect(found).toBe(day);
  });

  it("לא קיימת שורה תואמת → null, לא ניחוש", () => {
    expect(findWorkDateForReminder(yochi.key, "2031-01-01 00:00:00")).toBeNull();
  });

  it("יותר משורה תואמת אחת (reminder_sent_at זהה לשני ימים שונים) → null, לא בוחר אחד מהם כניחוש", () => {
    const sentAt = "2031-04-14 10:00:00";
    db.prepare(
      `INSERT INTO attendance_days (user_key, work_date, status, reminder_status, reminder_sent_at, updated_at)
       VALUES (?, '2031-04-14', 'closed', 'sent', ?, datetime('now'))`,
    ).run(yochi.key, sentAt);
    db.prepare(
      `INSERT INTO attendance_days (user_key, work_date, status, reminder_status, reminder_sent_at, updated_at)
       VALUES (?, '2031-04-15', 'closed', 'sent', ?, datetime('now'))`,
    ).run(yochi.key, sentAt);

    expect(findWorkDateForReminder(yochi.key, sentAt)).toBeNull();
  });

  it("מבודד בין משתמשים — reminder_sent_at זהה אצל שני עובדים לא מתערבב", async () => {
    setAttendanceReminderTime(yochi, 10, 0);
    setAttendanceReminderTime(dov, 10, 0);
    const day = "2031-04-16";
    checkAttendanceDayStart(yochi, at(day, "08:00"));
    checkAttendanceDayStart(dov, at(day, "08:00"));
    await runAttendanceReminderTick(at(day, "10:00"));

    const yochiSentAt = getDay(yochi.key, day)?.reminderSentAt;
    const dovSentAt = getDay(dov.key, day)?.reminderSentAt;
    expect(yochiSentAt).not.toBeNull();
    // גם אם נדמה (תיאורטית) ל-reminder_sent_at זהה בדיוק לשני המשתמשים — ה-lookup פר-user_key.
    expect(findWorkDateForReminder(yochi.key, yochiSentAt!)).toBe(day);
    expect(findWorkDateForReminder(dov.key, dovSentAt!)).toBe(day);
    expect(findWorkDateForReminder("someone-else-entirely", yochiSentAt!)).toBeNull();
  });
});

describe("addNotification — ללא ctx נשאר context=NULL (non-regression — כל שאר קוראי addNotification לא מושפעים)", () => {
  it("addNotification בלי ctx עדיין יוצר context=NULL כמו קודם", () => {
    const id = addNotification(yochi.key, "attendance_reminder", "טקסט בדיקה בלבד");
    const row = db.prepare(`SELECT context_json FROM notifications WHERE id = ?`).get(id) as { context_json: string | null };
    expect(row.context_json).toBeNull();
    db.prepare(`DELETE FROM notifications WHERE id = ?`).run(id);
  });
});
