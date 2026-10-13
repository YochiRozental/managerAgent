import { db } from "../db.js";
import type { AttendanceEventType } from "../../ops/attendanceEngine.js";

/**
 * יומן ביקורת לבקשות תיקון נוכחות. old_value/new_value/reason/requested_by/created_at לעולם לא
 * משתנים אחרי יצירה — רק status/approved_by/decided_at/applied_event_id מתעדכנים בהכרעה, פעם
 * אחת, מוגן ב-CAS (decideCorrection). מדיניות (אושרה 2026-10-11):
 *   • תיקון עצמי כל עוד חודש השכר פתוח → applied אוטומטית (auto_approved=1), בלי הכרעת מוטי.
 *   • חודש סגור → pending_approval, ממתין להכרעת מוטי (approve:sensitive).
 */

export type CorrectionStatus = "pending_approval" | "applied" | "rejected";

export interface StoredCorrection {
  id: number;
  userKey: string;
  requestedBy: string;
  workDate: string;
  targetEventId: number | null;
  field: AttendanceEventType;
  oldValue: string | null;
  newValue: string;
  reason: string | null;
  payrollMonth: string;
  status: CorrectionStatus;
  autoApproved: boolean;
  approvedBy: string | null;
  appliedEventId: number | null;
  idempotencyKey: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface Row {
  id: number;
  user_key: string;
  requested_by: string;
  work_date: string;
  target_event_id: number | null;
  field: string;
  old_value: string | null;
  new_value: string;
  reason: string | null;
  payroll_month: string;
  status: string;
  auto_approved: number;
  approved_by: string | null;
  applied_event_id: number | null;
  idempotency_key: string | null;
  created_at: string;
  decided_at: string | null;
}

function fromRow(r: Row): StoredCorrection {
  return {
    id: r.id,
    userKey: r.user_key,
    requestedBy: r.requested_by,
    workDate: r.work_date,
    targetEventId: r.target_event_id,
    field: r.field as AttendanceEventType,
    oldValue: r.old_value,
    newValue: r.new_value,
    reason: r.reason,
    payrollMonth: r.payroll_month,
    status: r.status as CorrectionStatus,
    autoApproved: r.auto_approved === 1,
    approvedBy: r.approved_by,
    appliedEventId: r.applied_event_id,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM attendance_corrections WHERE id = ?`);
const getByIdempotencyKeyStmt = db.prepare(`SELECT * FROM attendance_corrections WHERE idempotency_key = ?`);
const insertStmt = db.prepare(
  `INSERT INTO attendance_corrections
     (user_key, requested_by, work_date, target_event_id, field, old_value, new_value, reason, payroll_month, status, auto_approved, idempotency_key)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const listPendingStmt = db.prepare(`SELECT * FROM attendance_corrections WHERE status = 'pending_approval' ORDER BY id ASC LIMIT ?`);
const listForUserStmt = db.prepare(`SELECT * FROM attendance_corrections WHERE user_key = ? ORDER BY id DESC LIMIT ?`);
// CAS — pending_approval→applied/rejected בלבד. מגן על הכרעה כפולה (שני קליקים/מירוץ).
const decideStmt = db.prepare(
  `UPDATE attendance_corrections SET status = ?, approved_by = ?, applied_event_id = ?, decided_at = datetime('now')
   WHERE id = ? AND status = 'pending_approval'`,
);

export interface CreateCorrectionInput {
  userKey: string;
  requestedBy: string;
  workDate: string;
  targetEventId: number | null;
  field: AttendanceEventType;
  oldValue: string | null;
  newValue: string;
  reason: string | null;
  payrollMonth: string;
  autoApproved: boolean;
  /** מזהה הודעה/פעולה יציב (buildMessageIdempotencySeed) — retry של אותה בקשה מחזיר את השורה
   *  הקיימת בלי ליצור שנייה. חובה (לא אופציונלי) — לכל בקשת תיקון יש הודעה שהולידה אותה. */
  idempotencyKey: string;
}

/**
 * status ההתחלתי: autoApproved=true → 'applied' ישר (עדיין בלי applied_event_id — זה מתמלא
 * בסבב נפרד אחרי שהאירוע עצמו נכתב, ר' attendance.ts); אחרת 'pending_approval'.
 * idempotency: אם idempotencyKey כבר קיים — מחזירים את הבקשה הקיימת (created:false), לא יוצרים
 * שנייה. זה *בנוסף* ל-idempotency של attendance_events עצמו (correction:${id}) — מגן על השלב
 * המוקדם יותר (יצירת הבקשה), לא רק על כתיבת האירוע.
 */
export function createCorrectionRequest(input: CreateCorrectionInput): { correction: StoredCorrection; created: boolean } {
  const existing = getByIdempotencyKeyStmt.get(input.idempotencyKey) as unknown as Row | undefined;
  if (existing) return { correction: fromRow(existing), created: false };

  const info = insertStmt.run(
    input.userKey,
    input.requestedBy,
    input.workDate,
    input.targetEventId,
    input.field,
    input.oldValue,
    input.newValue,
    input.reason,
    input.payrollMonth,
    input.autoApproved ? "applied" : "pending_approval",
    input.autoApproved ? 1 : 0,
    input.idempotencyKey,
  );
  const row = getByIdempotencyKeyStmt.get(input.idempotencyKey) as unknown as Row | undefined;
  // אם מישהו הקדים בין ה-SELECT ל-INSERT (לא צריך לקרות סינכרונית) — ה-UNIQUE index תפס, קוראים
  // חזרה לפי המפתח, לא לפי lastInsertRowid.
  return { correction: fromRow(row ?? (getStmt.get(Number(info.lastInsertRowid)) as unknown as Row)), created: true };
}

/**
 * audit שלב ז (2026-10-13) — מאפשר לקורא (attendance.ts) לבדוק retry *לפני* תיקוף-רצף/סימולציה,
 * לא רק כש-createCorrectionRequest כבר רץ. בלעדי זה, insertNew (תוספת אירוע) נכשל בטעות על retry
 * אמיתי: ה-simulateCorrection ב-attendance.ts בונה מהיומן *הנוכחי* (שכבר כולל את האירוע שהניסיון
 * הראשון הוסיף בפועל) ומוסיף *עוד* הצעה — שתי תוספות-מדומות באותו רגע נראות כרצף לא תקין, גם
 * כש-זו בדיוק אותה בקשה. בדיוק עיקרון getEventByIdempotencyKey ב-attendanceEvents.ts.
 */
export function getCorrectionByIdempotencyKey(idempotencyKey: string): StoredCorrection | null {
  const row = getByIdempotencyKeyStmt.get(idempotencyKey) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

export function getCorrection(id: number): StoredCorrection | null {
  const row = getStmt.get(id) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listPendingCorrections(limit = 100): StoredCorrection[] {
  return (listPendingStmt.all(limit) as unknown as Row[]).map(fromRow);
}

export function listCorrectionsForUser(userKey: string, limit = 50): StoredCorrection[] {
  return (listForUserStmt.all(userKey, limit) as unknown as Row[]).map(fromRow);
}

/** true ⇔ הכרעה זו היא שתפסה בפועל (לא כבר-הוכרע קודם). appliedEventId רלוונטי רק ל-'applied'. */
export function decideCorrection(id: number, status: "applied" | "rejected", approvedBy: string, appliedEventId: number | null): boolean {
  return decideStmt.run(status, approvedBy, appliedEventId, id).changes === 1;
}

/** ממלאת applied_event_id על בקשה שכבר applied (auto_approved) — אחרי שהאירוע בפועל נכתב. */
export function attachAppliedEvent(id: number, appliedEventId: number): void {
  db.prepare(`UPDATE attendance_corrections SET applied_event_id = ? WHERE id = ? AND status = 'applied'`).run(appliedEventId, id);
}
