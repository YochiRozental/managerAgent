import { db } from "../db.js";
import type { AttendanceEventType } from "../../ops/attendanceEngine.js";

/**
 * יומן האירועים — append-only אמיתי. אין שום UPDATE על event_type/reported_for_at/source/note
 * של שורה קיימת בקובץ הזה. תיקון = שורה חדשה (event_type='correction') שמצביעה (corrects_event_id)
 * על האירוע שהיא מתקנת — ר' attendanceCorrections.ts/attendance.ts.
 */

export type EventSource = "chat_window" | "whatsapp" | "correction";

export interface StoredAttendanceEvent {
  id: number;
  userKey: string;
  workDate: string;
  eventType: AttendanceEventType | "correction";
  effectiveEventType: AttendanceEventType | null;
  correctsEventId: number | null;
  reportedForAt: string;
  receivedAt: string;
  source: EventSource;
  sequenceNo: number;
  requestedBy: string | null;
  note: string | null;
  idempotencyKey: string;
  createdAt: string;
}

interface Row {
  id: number;
  user_key: string;
  work_date: string;
  event_type: string;
  effective_event_type: string | null;
  corrects_event_id: number | null;
  reported_for_at: string;
  received_at: string;
  source: string;
  sequence_no: number;
  requested_by: string | null;
  note: string | null;
  idempotency_key: string;
  created_at: string;
}

function fromRow(r: Row): StoredAttendanceEvent {
  return {
    id: r.id,
    userKey: r.user_key,
    workDate: r.work_date,
    eventType: r.event_type as AttendanceEventType | "correction",
    effectiveEventType: (r.effective_event_type as AttendanceEventType | null) ?? null,
    correctsEventId: r.corrects_event_id,
    reportedForAt: r.reported_for_at,
    receivedAt: r.received_at,
    source: r.source as EventSource,
    sequenceNo: r.sequence_no,
    requestedBy: r.requested_by,
    note: r.note,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM attendance_events WHERE id = ?`);
const getByKeyStmt = db.prepare(`SELECT * FROM attendance_events WHERE idempotency_key = ?`);
const nextSeqStmt = db.prepare(
  `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next FROM attendance_events WHERE user_key = ? AND work_date = ?`,
);
const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO attendance_events
     (user_key, work_date, event_type, effective_event_type, corrects_event_id, reported_for_at,
      source, sequence_no, requested_by, note, idempotency_key)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const listForDayStmt = db.prepare(
  `SELECT * FROM attendance_events WHERE user_key = ? AND work_date = ? ORDER BY sequence_no ASC`,
);
const listCorrectionsForDayStmt = db.prepare(
  `SELECT * FROM attendance_events WHERE user_key = ? AND work_date = ? AND event_type = 'correction' ORDER BY sequence_no ASC`,
);

export interface InsertEventInput {
  userKey: string;
  workDate: string;
  eventType: AttendanceEventType | "correction";
  effectiveEventType?: AttendanceEventType;
  correctsEventId?: number;
  reportedForAt: string;
  source: EventSource;
  requestedBy?: string;
  note?: string;
  idempotencyKey: string;
}

export interface InsertEventResult {
  event: StoredAttendanceEvent;
  /** false ⇔ idempotency_key כבר היה קיים — האירוע שחזר הוא הקודם, לא אירוע חדש. */
  created: boolean;
}

/**
 * מכניס אירוע חדש. sequence_no מחושב כאן (MAX+1) ברגע ההכנסה — בלי await בין הקריאה לכתיבה
 * (node:sqlite סינכרוני, אותו עיקרון כמו claimApproval/claimFollowupForProcessing), אז אין חלון
 * מירוץ אמיתי תוך תהליך Node בודד. idempotency_key הוא ה-UNIQUE constraint שמונע כפילות אמיתית
 * (retry/הודעה כפולה) — INSERT OR IGNORE, בדיוק תבנית idempotentCreations.ts.
 */
export function insertEvent(input: InsertEventInput): InsertEventResult {
  const existing = getByKeyStmt.get(input.idempotencyKey) as unknown as Row | undefined;
  if (existing) return { event: fromRow(existing), created: false };

  const { next } = nextSeqStmt.get(input.userKey, input.workDate) as unknown as { next: number };
  insertStmt.run(
    input.userKey,
    input.workDate,
    input.eventType,
    input.effectiveEventType ?? null,
    input.correctsEventId ?? null,
    input.reportedForAt,
    input.source,
    next,
    input.requestedBy ?? null,
    input.note ?? null,
    input.idempotencyKey,
  );
  // אם בכל זאת מישהו הקדים בין ה-SELECT ל-INSERT (לא צריך לקרות סינכרונית, אבל לא מניחים) —
  // ה-UNIQUE constraint מנע כפילות; קוראים חזרה לפי המפתח, לא לפי lastInsertRowid.
  const row = getByKeyStmt.get(input.idempotencyKey) as unknown as Row;
  return { event: fromRow(row), created: true };
}

export function getEvent(id: number): StoredAttendanceEvent | null {
  const row = getStmt.get(id) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

/**
 * בדיקה *לפני* הכתיבה — "האם ההודעה הזו בדיוק כבר טופלה?" (retry/resend). חובה לבדוק את זה
 * *לפני* checkTransition בצד הקורא (attendance.ts): אחרי שהריצה הראשונה של אותה הודעה כבר שינתה
 * את ה-state, ריצה שנייה (retry) שתבדוק checkTransition על ה-state *החדש* תיכשל בטעות (למשל
 * "אתה כבר בהפסקה") — למרות שזו בדיוק אותה פעולה שכבר הצליחה, לא פעולה שנייה סותרת.
 */
export function getEventByIdempotencyKey(key: string): StoredAttendanceEvent | null {
  const row = getByKeyStmt.get(key) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listEventsForDay(userKey: string, workDate: string): StoredAttendanceEvent[] {
  return (listForDayStmt.all(userKey, workDate) as unknown as Row[]).map(fromRow);
}

export function listCorrectionsForDay(userKey: string, workDate: string): StoredAttendanceEvent[] {
  return (listCorrectionsForDayStmt.all(userKey, workDate) as unknown as Row[]).map(fromRow);
}
