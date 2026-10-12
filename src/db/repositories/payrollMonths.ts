import { db } from "../db.js";

/**
 * מצב "חודש שכר" — פתוח/סגור. היעדר שורה = פתוח (ברירת המחדל; שום דבר לא נסגר אוטומטית — ר'
 * attendance_corrections policy ב-attendance.ts). סגירה/פתיחה מחדש הן פעולות מפורשות של בעל
 * הרשאה (approve:sensitive) — לא קרויות משום scheduler/job אוטומטי בקוד הזה.
 */

export interface PayrollMonthLock {
  month: string; // YYYY-MM
  closedBy: string;
  closedAt: string;
  reopenedBy: string | null;
  reopenedAt: string | null;
}

interface Row {
  month: string;
  closed_by: string;
  closed_at: string;
  reopened_by: string | null;
  reopened_at: string | null;
}

function fromRow(r: Row): PayrollMonthLock {
  return { month: r.month, closedBy: r.closed_by, closedAt: r.closed_at, reopenedBy: r.reopened_by, reopenedAt: r.reopened_at };
}

const getStmt = db.prepare(`SELECT * FROM payroll_month_locks WHERE month = ?`);
const closeStmt = db.prepare(
  `INSERT INTO payroll_month_locks (month, closed_by) VALUES (?, ?)
   ON CONFLICT (month) DO UPDATE SET closed_by = excluded.closed_by, closed_at = datetime('now'), reopened_by = NULL, reopened_at = NULL`,
);
const reopenStmt = db.prepare(
  `UPDATE payroll_month_locks SET reopened_by = ?, reopened_at = datetime('now') WHERE month = ? AND reopened_at IS NULL`,
);

export function getPayrollMonthLock(month: string): PayrollMonthLock | null {
  const row = getStmt.get(month) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

/** true ⇔ יש שורה סגורה שלא נפתחה מחדש. היעדר שורה בכלל = פתוח = false. */
export function isPayrollMonthClosed(month: string): boolean {
  const lock = getPayrollMonthLock(month);
  return !!lock && lock.reopenedAt === null;
}

/** פעולה מפורשת בלבד — לא קרויה משום job/scheduler. לא מופעלת בשום מקום בשלב זה. */
export function closePayrollMonth(month: string, byUserKey: string): PayrollMonthLock {
  closeStmt.run(month, byUserKey);
  return getPayrollMonthLock(month)!;
}

/** true ⇔ היה סגור בפועל ועכשיו נפתח. false אם לא היה סגור כלל/כבר נפתח קודם. */
export function reopenPayrollMonth(month: string, byUserKey: string): boolean {
  return reopenStmt.run(byUserKey, month).changes === 1;
}
