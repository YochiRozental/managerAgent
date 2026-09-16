import { db } from "../db.js";

/**
 * Follow-up Engine — "אני צריך לחזור לבדוק את זה בתאריך/שעה מסוימים", בתשתית persistent אחת,
 * גנרית לפי kind. Monday נשאר מקור האמת למשימות; זו רק זיכרון מעקב (2026-09-14, מתוקן 2026-09-15).
 *
 * Audit 2026-09-15 — שני תיקונים מרכזיים:
 *   1. status 'processing' (claim→ניסיון שליחה→triggered/pending) — כדי שכשל בשליחה (Monday/DB/SSE)
 *      לא ישאיר follow-up "כאילו נשלח" לצמיתות. recoverStuckFollowups() משחזר קריסה באמצע, בדיוק
 *      כמו recoverStuckApprovals() ב-manager_approvals.
 *   2. הזהות של "אותה משימה" ל-idempotency היא item_id+item_source+kind בלבד — לעולם לא finding_key
 *      (יכול להשתנות, ראה deferralHistory.ts). retireCommitmentChecksForItem מבטלת pending *וגם*
 *      משלימה triggered — לא רק pending — כדי שלא יישאר מעקב-ישן תקוע כשנוצר חדש.
 */

export type FollowupKind =
  | "commitment_check"
  | "external_wait_check"
  | "no_response_reminder"
  | "end_of_day_check"
  /** Rule 18 (EOD Engine, 2026-09-16): אין תשובה עד סוף היום — התראה ניהולית למוטי, לא Approval. */
  | "end_of_day_no_response"
  | "manager_followup"
  /**
   * Rule 1 (פנייה ראשונית, audit 2026-09-17): תזמון נפרד לגמרי מ-no_response_reminder/
   * end_of_day_no_response הגלובליים (commitment_check/end_of_day_check) — כדי שגלגול ליום
   * העסקים הבא (כשאין ~3 שעות עבודה נותרות היום) לא ישפיע על ה-flow הקיים. ר' escalation.ts
   * (buildInitialOverdueNudgeText, השלב בין upsert ל-הסלמה) ו-followups.ts (scheduleInitialNudgeFollowup).
   */
  | "initial_nudge_reminder"
  | "initial_nudge_eod";

export type FollowupStatus = "pending" | "processing" | "triggered" | "completed" | "cancelled";

export interface StoredFollowup {
  id: number;
  findingKey: string | null;
  itemId: string | null;
  itemSource: string | null;
  userKey: string;
  kind: FollowupKind;
  /** ISO datetime, תמיד UTC (ראה followups.ts) — לא לפרש כשעון מקומי. */
  dueAt: string;
  status: FollowupStatus;
  payload: Record<string, unknown> | null;
  createdAt: string;
  processingStartedAt: string | null;
  lastError: string | null;
  triggeredAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

interface Row {
  id: number;
  finding_key: string | null;
  item_id: string | null;
  item_source: string | null;
  user_key: string;
  kind: string;
  due_at: string;
  status: string;
  payload_json: string | null;
  created_at: string;
  processing_started_at: string | null;
  last_error: string | null;
  triggered_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

function fromRow(r: Row): StoredFollowup {
  return {
    id: r.id,
    findingKey: r.finding_key,
    itemId: r.item_id,
    itemSource: r.item_source,
    userKey: r.user_key,
    kind: r.kind as FollowupKind,
    dueAt: r.due_at,
    status: r.status as FollowupStatus,
    payload: r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null,
    createdAt: r.created_at,
    processingStartedAt: r.processing_started_at,
    lastError: r.last_error,
    triggeredAt: r.triggered_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM control_followups WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO control_followups (finding_key, item_id, item_source, user_key, kind, due_at, payload_json)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const listDueStmt = db.prepare(
  `SELECT * FROM control_followups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC`,
);

// ─────────────────────────────────────────────────────────────────────────────
// claim (pending→processing) → triggered (הצליח) | pending+error (נכשל) — ראה followups.ts
// ─────────────────────────────────────────────────────────────────────────────
const claimStmt = db.prepare(
  `UPDATE control_followups SET status = 'processing', processing_started_at = datetime('now'), last_error = NULL
   WHERE id = ? AND status = 'pending'`,
);
const markTriggeredStmt = db.prepare(
  `UPDATE control_followups SET status = 'triggered', triggered_at = datetime('now') WHERE id = ? AND status = 'processing'`,
);
const revertToPendingStmt = db.prepare(
  `UPDATE control_followups SET status = 'pending', last_error = ? WHERE id = ? AND status = 'processing'`,
);
// שחזור אחרי קריסה (Audit 2026-09-15, כמו recoverStuckApprovals): 'processing' הוא מצב-מעבר
// תוך-בקשה בלבד. שורה שנמצאת בו ב-STARTUP (לא תוך כדי טיפול פעיל) קרתה רק כי תהליך קרס בין
// claim לתוצאה. מחזירים ל-pending עם שגיאה גלויה — לא מוחקים, לא מנחשים אם הפנייה כן/לא נשלחה.
const recoverStuckStmt = db.prepare(
  `UPDATE control_followups
     SET status = 'pending', last_error = 'התהליך הופסק באמצע עיבוד (קריסה/ריסטרט) — ייבדק שוב בהרצה הבאה.'
   WHERE status = 'processing'`,
);

const completeStmt = db.prepare(
  `UPDATE control_followups SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status IN ('pending','processing','triggered')`,
);
const cancelPendingForItemKindStmt = db.prepare(
  `UPDATE control_followups SET status = 'cancelled', cancelled_at = datetime('now')
   WHERE item_id = ? AND item_source = ? AND kind = ? AND status = 'pending'`,
);
const completeActiveForItemKindStmt = db.prepare(
  `UPDATE control_followups SET status = 'completed', completed_at = datetime('now')
   WHERE item_id = ? AND item_source = ? AND kind = ? AND status IN ('processing','triggered')`,
);
const completeActiveForItemStmt = db.prepare(
  `UPDATE control_followups SET status = 'completed', completed_at = datetime('now')
   WHERE item_id = ? AND item_source = ? AND status IN ('pending','processing','triggered')`,
);
const listAllStmt = db.prepare(`SELECT * FROM control_followups ORDER BY due_at DESC LIMIT ?`);
const listByStatusStmt = db.prepare(`SELECT * FROM control_followups WHERE status = ? ORDER BY due_at DESC LIMIT ?`);

export interface CreateFollowupInput {
  findingKey?: string;
  itemId?: string;
  itemSource?: string;
  userKey: string;
  kind: FollowupKind;
  /** ISO datetime — **חייב להיות UTC** (ראה followups.ts: כל מחשבי ה-dueAt כבר עושים .toUTC()). */
  dueAtISO: string;
  payload?: Record<string, unknown>;
}

export function createFollowup(input: CreateFollowupInput): StoredFollowup {
  const info = insertStmt.run(
    input.findingKey ?? null,
    input.itemId ?? null,
    input.itemSource ?? null,
    input.userKey,
    input.kind,
    input.dueAtISO,
    input.payload ? JSON.stringify(input.payload) : null,
  );
  return fromRow(getStmt.get(Number(info.lastInsertRowid)) as unknown as Row);
}

export function getFollowup(id: number): StoredFollowup | null {
  const row = getStmt.get(id) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

/** follow-ups שהגיע זמנם — status=pending ו-due_at<=nowUtcIso. מה-ישן לחדש. nowUtcIso חייב UTC. */
export function listDueFollowups(nowUtcIso: string): StoredFollowup[] {
  return (listDueStmt.all(nowUtcIso) as unknown as Row[]).map(fromRow);
}

/**
 * תפיסה אטומית **לפני** כל ניסיון שליחה — pending→processing. CAS סינכרוני: שני runner-ים
 * "בו-זמנית" (בלי await ביניהם) — רק אחד יצליח, השני מדלג. עדיין לא "נשלח" — רק "בטיפול".
 */
export function claimFollowupForProcessing(id: number): boolean {
  return claimStmt.run(id).changes === 1;
}

/** רק אחרי ששליחת הפנייה *באמת* הצליחה. */
export function markFollowupTriggered(id: number): boolean {
  return markTriggeredStmt.run(id).changes === 1;
}

/** שליחה נכשלה — חוזר ל-pending עם שגיאה, כדי שההרצה הבאה תנסה שוב. לא "נעלם". */
export function revertFollowupToPending(id: number, error: string): boolean {
  return revertToPendingStmt.run(error, id).changes === 1;
}

/** startup בלבד (לא scheduler) — משחזר follow-ups שנשארו תקועים ב-processing מקריסה קודמת. */
export function recoverStuckFollowups(): number {
  return Number(recoverStuckStmt.run().changes);
}

export function completeFollowup(id: number): boolean {
  return completeStmt.run(id).changes === 1;
}

/**
 * מבטלת/משלימה את מעקבי ה-kind הזה שעדיין פעילים על הפריט — pending מבוטל (לא הגיע לשלוח כלום),
 * processing/triggered מושלם (כבר בטיפול/כבר נשלח, קיבל תשובה בדרך אחרת — לא נשאר תקוע).
 * הזהות היא item_id+item_source+kind בלבד, **לעולם לא finding_key** — יכול להשתנות באמצע
 * (ראה deferralHistory.ts / audit 2026-09-14), ואסור שזה ייצור מעקב כפול או יאבד את הישן.
 */
export function retireFollowupsForItemKind(itemId: string, itemSource: string, kind: FollowupKind): number {
  const cancelled = cancelPendingForItemKindStmt.run(itemId, itemSource, kind).changes;
  const completed = completeActiveForItemKindStmt.run(itemId, itemSource, kind).changes;
  return Number(cancelled) + Number(completed);
}

/** משלים כל follow-up פעיל (כל kind) על הפריט — המשימה נסגרה / העובד השיב תשובה שממצה את המחזור. */
export function completeActiveFollowupsForItem(itemId: string, itemSource: string): number {
  return Number(completeActiveForItemStmt.run(itemId, itemSource).changes);
}

/**
 * מבטלת/משלימה את מעקב ה-kind הזה הפעיל הישן על הפריט (אם יש — בכל סטטוס פעיל), ויוצרת אחד חדש.
 * תמיד ברור מה המעקב הפעיל הבא מאותו kind על הפריט — אף פעם לא שני מעקבים מאותו kind פעילים
 * במקביל, בין אם הישן עוד pending ובין אם כבר triggered (Audit 2026-09-15, הורחב ל-EOD Engine 2026-09-16).
 */
export function createOrReplaceFollowupForKind(kind: FollowupKind, input: CreateFollowupInput): StoredFollowup {
  if (input.itemId && input.itemSource) {
    retireFollowupsForItemKind(input.itemId, input.itemSource, kind);
  }
  return createFollowup(input);
}

export function createOrReplaceCommitmentCheck(input: CreateFollowupInput): StoredFollowup {
  return createOrReplaceFollowupForKind("commitment_check", input);
}

/** ל-GET /api/control/followups (debug, מוטי/owner בלבד). */
export function listFollowups(opts: { status?: FollowupStatus; limit?: number } = {}): StoredFollowup[] {
  const limit = opts.limit ?? 100;
  const rows = opts.status ? listByStatusStmt.all(opts.status, limit) : listAllStmt.all(limit);
  return (rows as unknown as Row[]).map(fromRow);
}
