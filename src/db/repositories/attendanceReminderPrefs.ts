import { db } from "../db.js";

export interface AttendanceReminderPref {
  userKey: string;
  reminderHour: number | null;
  reminderMinute: number | null;
  firstAskedAt: string | null;
  updatedAt: string;
}

interface Row {
  user_key: string;
  reminder_hour: number | null;
  reminder_minute: number | null;
  first_asked_at: string | null;
  updated_at: string;
}

function fromRow(r: Row): AttendanceReminderPref {
  return {
    userKey: r.user_key,
    reminderHour: r.reminder_hour,
    reminderMinute: r.reminder_minute,
    firstAskedAt: r.first_asked_at,
    updatedAt: r.updated_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM attendance_reminder_prefs WHERE user_key = ?`);
const markAskedStmt = db.prepare(
  `INSERT INTO attendance_reminder_prefs (user_key, first_asked_at) VALUES (?, datetime('now'))
   ON CONFLICT (user_key) DO NOTHING`,
);
const setTimeStmt = db.prepare(
  `INSERT INTO attendance_reminder_prefs (user_key, reminder_hour, reminder_minute, updated_at)
   VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT (user_key) DO UPDATE SET reminder_hour = excluded.reminder_hour, reminder_minute = excluded.reminder_minute, updated_at = datetime('now')`,
);

export function getReminderPref(userKey: string): AttendanceReminderPref | null {
  const row = getStmt.get(userKey) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

/** "פעם ראשונה שהעובד משתמש במודול" = עדיין אין שורה כלל. נקראת כש-Day-Start Gate שואל את שעת
 *  התזכורת בפעם הראשונה — לא נקראת שוב אחרי זה (ר' attendance.ts). */
export function markReminderAsked(userKey: string): void {
  markAskedStmt.run(userKey);
}

/** נקראת גם מהתשובה הראשונה לשאלה וגם משינוי מאוחר יותר ("תזכיר לי ב-17:30") — אותה פעולה בדיוק. */
export function setReminderTime(userKey: string, hour: number, minute: number): AttendanceReminderPref {
  setTimeStmt.run(userKey, hour, minute);
  return getReminderPref(userKey)!;
}
