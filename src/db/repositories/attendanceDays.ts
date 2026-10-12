import { db } from "../db.js";
import type { AttendanceStatus } from "../../ops/attendanceEngine.js";

/**
 * Cache נגזר של attendance_events — לא מקור אמת (אפשר לבנות מחדש מהיומן בכל רגע), נשמר כדי
 * לא לשחזר ולסכם את כל אירועי היום בכל שאילתה. נכתב תמיד דרך recomputeAndPersist (attendance.ts),
 * אף פעם לא ישירות ממקום אחר.
 */

export type AttendanceDayStatus = AttendanceStatus | "pending_completion";
export type MondaySyncStatus = "not_synced" | "pending" | "synced" | "failed";
export type ReminderStatus = "none" | "pending_send" | "sent";

export interface StoredAttendanceDay {
  userKey: string;
  workDate: string;
  status: AttendanceDayStatus;
  openedReportedAt: string | null;
  closedReportedAt: string | null;
  netMinutes: number | null;
  breakMinutes: number;
  segmentCount: number;
  reminderStatus: ReminderStatus;
  reminderSentAt: string | null;
  mondaySyncStatus: MondaySyncStatus;
  mondaySyncRef: string | null;
  updatedAt: string;
}

interface Row {
  user_key: string;
  work_date: string;
  status: string;
  opened_reported_at: string | null;
  closed_reported_at: string | null;
  net_minutes: number | null;
  break_minutes: number;
  segment_count: number;
  reminder_status: string;
  reminder_sent_at: string | null;
  monday_sync_status: string;
  monday_sync_ref: string | null;
  updated_at: string;
}

function fromRow(r: Row): StoredAttendanceDay {
  return {
    userKey: r.user_key,
    workDate: r.work_date,
    status: r.status as AttendanceDayStatus,
    openedReportedAt: r.opened_reported_at,
    closedReportedAt: r.closed_reported_at,
    netMinutes: r.net_minutes,
    breakMinutes: r.break_minutes,
    segmentCount: r.segment_count,
    reminderStatus: r.reminder_status as ReminderStatus,
    reminderSentAt: r.reminder_sent_at,
    mondaySyncStatus: r.monday_sync_status as MondaySyncStatus,
    mondaySyncRef: r.monday_sync_ref,
    updatedAt: r.updated_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM attendance_days WHERE user_key = ? AND work_date = ?`);
const upsertStmt = db.prepare(
  `INSERT INTO attendance_days
     (user_key, work_date, status, opened_reported_at, closed_reported_at, net_minutes, break_minutes,
      segment_count, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
   ON CONFLICT (user_key, work_date) DO UPDATE SET
     status = excluded.status,
     opened_reported_at = excluded.opened_reported_at,
     closed_reported_at = excluded.closed_reported_at,
     net_minutes = excluded.net_minutes,
     break_minutes = excluded.break_minutes,
     segment_count = excluded.segment_count,
     updated_at = datetime('now')`,
);
const findOpenBeforeStmt = db.prepare(
  `SELECT * FROM attendance_days WHERE user_key = ? AND status = 'open' AND work_date < ? ORDER BY work_date DESC LIMIT 1`,
);
const markPendingCompletionStmt = db.prepare(
  `UPDATE attendance_days SET status = 'pending_completion', updated_at = datetime('now')
   WHERE user_key = ? AND work_date = ? AND status = 'open'`,
);
const listDueForReminderStmt = db.prepare(
  `SELECT d.* FROM attendance_days d
   JOIN attendance_reminder_prefs p ON p.user_key = d.user_key
   WHERE d.status = 'open' AND d.reminder_status = 'none'
     AND p.reminder_hour IS NOT NULL AND p.reminder_minute IS NOT NULL
     AND (p.reminder_hour < ? OR (p.reminder_hour = ? AND p.reminder_minute <= ?))`,
);
// CAS — none→pending_send, רק אם עדיין none. מונע שליחה כפולה בין שני טיקים/אחרי ריסטרט.
const claimReminderStmt = db.prepare(
  `UPDATE attendance_days SET reminder_status = 'pending_send'
   WHERE user_key = ? AND work_date = ? AND status = 'open' AND reminder_status = 'none'`,
);
const markReminderSentStmt = db.prepare(
  `UPDATE attendance_days SET reminder_status = 'sent', reminder_sent_at = datetime('now')
   WHERE user_key = ? AND work_date = ? AND reminder_status = 'pending_send'`,
);
// שליחה נכשלה בפועל (לא רק "עדיין לא ידוע") — חוזרים ל-none כדי שהטיק הבא ינסה שוב.
const revertReminderStmt = db.prepare(
  `UPDATE attendance_days SET reminder_status = 'none'
   WHERE user_key = ? AND work_date = ? AND reminder_status = 'pending_send'`,
);
// שחזור אחרי קריסה (startup בלבד, לא scheduler) — 'pending_send' הוא מצב-מעבר תוך-בקשה בלבד;
// שורה שנמצאת בו ב-STARTUP קרתה רק כי התהליך קרס בין claim לתוצאה. בדיוק עיקרון recoverStuckFollowups.
const recoverStuckRemindersStmt = db.prepare(`UPDATE attendance_days SET reminder_status = 'none' WHERE reminder_status = 'pending_send'`);

// ── סנכרון Monday (שלב ד — claim/finalize/retry, בדיוק עיקרון התזכורות) ────────────────────────
// ימים שסיימו (closed) וצריכים סנכרון/ריסנכרון: not_synced (חדש, או אופס אחרי תיקון — ר'
// attendance.ts's recomputeAndPersistDay) או failed (ניסיון קודם נכשל — retry).
const listNeedingMondaySyncStmt = db.prepare(
  `SELECT * FROM attendance_days WHERE status = 'closed' AND monday_sync_status IN ('not_synced', 'failed') ORDER BY work_date ASC`,
);
// CAS — not_synced|failed → pending. מונע שני ריצות job חופפות מנסות לסנכרן את אותו יום בו-זמנית.
const claimMondaySyncStmt = db.prepare(
  `UPDATE attendance_days SET monday_sync_status = 'pending', updated_at = datetime('now')
   WHERE user_key = ? AND work_date = ? AND monday_sync_status IN ('not_synced', 'failed')`,
);
// רק מ-pending (CAS) — אם בינתיים recomputeAndPersistDay כבר אופס אותו חזרה ל-not_synced (תיקון
// שהגיע תוך-כדי הסנכרון), ה-UPDATE הזה לא תופס בכוונה: ה-resync הבא יתפוס את הערכים העדכניים.
const markMondaySyncedStmt = db.prepare(
  `UPDATE attendance_days SET monday_sync_status = 'synced', monday_sync_ref = ?, updated_at = datetime('now')
   WHERE user_key = ? AND work_date = ? AND monday_sync_status = 'pending'`,
);
const markMondaySyncFailedStmt = db.prepare(
  `UPDATE attendance_days SET monday_sync_status = 'failed', updated_at = datetime('now')
   WHERE user_key = ? AND work_date = ? AND monday_sync_status = 'pending'`,
);
// שחזור אחרי קריסה (startup בלבד) — 'pending' הוא מצב-מעבר תוך-ריצה בלבד, בדיוק כמו reminder_status.
const recoverStuckMondaySyncsStmt = db.prepare(`UPDATE attendance_days SET monday_sync_status = 'not_synced' WHERE monday_sync_status = 'pending'`);
// נקרא מ-recomputeAndPersistDay (attendance.ts) — "היום נסגר/תוקן, צריך (ל-ריסנכרן". לא CAS: תמיד
// מאפס, גם אם היה synced, כדי שתיקון אחרי סגירה יידחף שוב ל-Monday.
const markNeedsMondaySyncStmt = db.prepare(
  `UPDATE attendance_days SET monday_sync_status = 'not_synced', updated_at = datetime('now')
   WHERE user_key = ? AND work_date = ? AND monday_sync_status != 'not_synced'`,
);

export function getDay(userKey: string, workDate: string): StoredAttendanceDay | null {
  const row = getStmt.get(userKey, workDate) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

export interface UpsertDayInput {
  userKey: string;
  workDate: string;
  status: AttendanceDayStatus;
  openedReportedAt: string | null;
  closedReportedAt: string | null;
  netMinutes: number | null;
  breakMinutes: number;
  segmentCount: number;
}

/** נקראת אחרי כל כתיבה ל-attendance_events — משקפת מחדש את המצב הנגזר. לא נוגעת ב-reminder/sync. */
export function upsertDay(input: UpsertDayInput): StoredAttendanceDay {
  upsertStmt.run(
    input.userKey,
    input.workDate,
    input.status,
    input.openedReportedAt,
    input.closedReportedAt,
    input.netMinutes,
    input.breakMinutes,
    input.segmentCount,
  );
  return getDay(input.userKey, input.workDate)!;
}

/** היום הפתוח האחרון *לפני* workDate, אם יש — ה"יום קודם שנשאר פתוח" שדורש השלמה. */
export function findOpenDayBefore(userKey: string, workDate: string): StoredAttendanceDay | null {
  const row = findOpenBeforeStmt.get(userKey, workDate) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

export function markPendingCompletion(userKey: string, workDate: string): boolean {
  return markPendingCompletionStmt.run(userKey, workDate).changes === 1;
}

/** ימים פתוחים שהגיע זמן התזכורת האישית שלהם (שעה:דקה מקומיים, "בשעה או אחריה" — לא רק שווה,
 *  כדי שטיק שמפספס בדיוק את הדקה עדיין יתפוס בטיק הבא, כולל קאצ'-אפ אחרי ריסטרט). */
export function listOpenDaysDueForReminder(nowHour: number, nowMinute: number): StoredAttendanceDay[] {
  return (listDueForReminderStmt.all(nowHour, nowHour, nowMinute) as unknown as Row[]).map(fromRow);
}

export function claimReminder(userKey: string, workDate: string): boolean {
  return claimReminderStmt.run(userKey, workDate).changes === 1;
}

export function markReminderSent(userKey: string, workDate: string): boolean {
  return markReminderSentStmt.run(userKey, workDate).changes === 1;
}

export function revertReminderClaim(userKey: string, workDate: string): void {
  revertReminderStmt.run(userKey, workDate);
}

/** startup בלבד — ר' הערת recoverStuckRemindersStmt. מחזיר כמה שורות שוחזרו. */
export function recoverStuckAttendanceReminders(): number {
  return Number(recoverStuckRemindersStmt.run().changes);
}

export function listDaysNeedingMondaySync(): StoredAttendanceDay[] {
  return (listNeedingMondaySyncStmt.all() as unknown as Row[]).map(fromRow);
}

export function claimMondaySync(userKey: string, workDate: string): boolean {
  return claimMondaySyncStmt.run(userKey, workDate).changes === 1;
}

/** true ⇔ נרשם בפועל (היה עדיין 'pending' — לא אופס בינתיים ע"י תיקון מקביל). */
export function markMondaySynced(userKey: string, workDate: string, itemId: string): boolean {
  return markMondaySyncedStmt.run(itemId, userKey, workDate).changes === 1;
}

export function markMondaySyncFailed(userKey: string, workDate: string): boolean {
  return markMondaySyncFailedStmt.run(userKey, workDate).changes === 1;
}

/** startup בלבד — ר' הערת recoverStuckMondaySyncsStmt. מחזיר כמה שורות שוחזרו. */
export function recoverStuckMondaySyncs(): number {
  return Number(recoverStuckMondaySyncsStmt.run().changes);
}

/** נקרא מ-recomputeAndPersistDay כשיום נסגר/מתוקן — מסמן שצריך (ל-ריסנכרן. אין-אופ אם כבר not_synced. */
export function markNeedsMondaySync(userKey: string, workDate: string): void {
  markNeedsMondaySyncStmt.run(userKey, workDate);
}
