import { db } from "../db.js";

/**
 * מערכת האישורים למוטי — Approval הוא אובייקט persistent, לא notification.
 * שורד ריסטרט שרת; ה-notification רק מצביע אליו (context.approvalId).
 *
 * idempotency: claimApproval() היא UPDATE אטומית (סינכרונית — node:sqlite לא מריץ שאילתה שנייה
 * במקביל תוך כדי הראשונה, אין await בין הקריאה להחלטה) שמעבירה pending/pending_instruction →
 * approving, מותנית ב-WHERE status IN (...). אם שתי בקשות "אשר" מגיעות כמעט בו-זמנית — רק
 * אחת תצליח לתפוס (changes===1), השנייה מקבלת changes===0 ויודעת שכבר טופל, בלי לגעת ב-Monday.
 */

export type ApprovalStatus = "pending" | "pending_instruction" | "approving" | "approved" | "rejected" | "superseded";
export type ApprovalKind = "deferral" | "cancellation" | "reassignment";

export interface StoredApproval {
  id: number;
  status: ApprovalStatus;
  kind: ApprovalKind;
  requestedBy: string;
  managerUserKey: string;
  findingKey: string | null;
  itemId: string | null;
  itemSource: string | null;
  taskName: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  decisionBy: string | null;
  decisionNote: string | null;
  executionStatus: string | null;
  executionError: string | null;
}

interface Row {
  id: number;
  status: string;
  kind: string;
  requested_by: string;
  manager_user_key: string;
  finding_key: string | null;
  item_id: string | null;
  item_source: string | null;
  task_name: string | null;
  payload_json: string;
  created_at: string;
  decided_at: string | null;
  decision_by: string | null;
  decision_note: string | null;
  execution_status: string | null;
  execution_error: string | null;
}

function fromRow(r: Row): StoredApproval {
  return {
    id: r.id,
    status: r.status as ApprovalStatus,
    kind: r.kind as ApprovalKind,
    requestedBy: r.requested_by,
    managerUserKey: r.manager_user_key,
    findingKey: r.finding_key,
    itemId: r.item_id,
    itemSource: r.item_source,
    taskName: r.task_name,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decisionBy: r.decision_by,
    decisionNote: r.decision_note,
    executionStatus: r.execution_status,
    executionError: r.execution_error,
  };
}

const getStmt = db.prepare(`SELECT * FROM manager_approvals WHERE id = ?`);
const findOpenStmt = db.prepare(
  `SELECT * FROM manager_approvals
   WHERE finding_key = ? AND kind = ? AND status IN ('pending','pending_instruction')
   ORDER BY id DESC LIMIT 1`,
);
const insertStmt = db.prepare(
  `INSERT INTO manager_approvals
     (kind, requested_by, manager_user_key, finding_key, item_id, item_source, task_name, payload_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const listForManagerStmt = db.prepare(
  `SELECT * FROM manager_approvals WHERE manager_user_key = ? ORDER BY id DESC LIMIT ?`,
);
const claimStmt = db.prepare(
  `UPDATE manager_approvals SET status = 'approving' WHERE id = ? AND status IN ('pending','pending_instruction')`,
);
const finalizeApprovedStmt = db.prepare(
  `UPDATE manager_approvals
     SET status = 'approved', decided_at = datetime('now'), decision_by = ?, decision_note = ?, execution_status = 'executed'
   WHERE id = ? AND status = 'approving'`,
);
const revertAfterFailureStmt = db.prepare(
  `UPDATE manager_approvals SET status = 'pending', execution_status = 'failed', execution_error = ? WHERE id = ? AND status = 'approving'`,
);
const markRejectedStmt = db.prepare(
  `UPDATE manager_approvals
     SET status = 'rejected', decided_at = datetime('now'), decision_by = ?, decision_note = ?
   WHERE id = ? AND status IN ('pending','pending_instruction')`,
);
const markInstructionStmt = db.prepare(
  `UPDATE manager_approvals SET status = 'pending_instruction', decision_note = ?
   WHERE id = ? AND status IN ('pending','pending_instruction')`,
);
// תשובת העובד להנחיה/שאלה של מוטי: pending_instruction → pending בלבד — "הכדור חזר אצל מוטי".
// זה גם ה-CAS שמונע שתי תשובות/מירוץ מול הכרעה: רק אם השורה עדיין pending_instruction זה מצליח.
const returnToPendingStmt = db.prepare(
  `UPDATE manager_approvals SET status = 'pending' WHERE id = ? AND status = 'pending_instruction'`,
);
const supersedeStmt = db.prepare(
  `UPDATE manager_approvals SET status = 'superseded', decided_at = datetime('now') WHERE id = ? AND status IN ('pending','pending_instruction')`,
);
// שחזור אחרי קריסה (Audit 2026-09-14): 'approving' הוא מצב-מעבר תוך-בקשה בלבד — שום קוד לא
// מתכוון להשאיר אותו כך ולהחזיר שליטה לקורא. אם שורה נמצאת ב-'approving' ב-STARTUP (לא תוך כדי
// טיפול פעיל בבקשה), זה יכול לקרות רק בגלל תהליך שקרס בין claim ל-finalize/revert. מחזירים
// ל-pending עם שגיאה גלויה — לא מוחקים, לא מנחשים אם Monday כן/לא התעדכן.
const recoverStuckStmt = db.prepare(
  `UPDATE manager_approvals
     SET status = 'pending', execution_status = 'failed',
         execution_error = 'התהליך הופסק באמצע ביצוע (קריסה/ריסטרט) — יש לבדוק ידנית אם Monday כבר התעדכן, ואז להחליט מחדש.'
   WHERE status = 'approving'`,
);

export interface CreateApprovalInput {
  kind: ApprovalKind;
  requestedBy: string;
  managerUserKey: string;
  findingKey?: string;
  itemId?: string;
  itemSource?: string;
  taskName?: string;
  payload: Record<string, unknown>;
}

/**
 * יוצר בקשת אישור חדשה — או, אם כבר יש אחת פתוחה (pending/pending_instruction) לאותו
 * finding_key+kind, מחזיר אותה בלי ליצור כפילות ("אם כבר קיימת בקשה זהה... אל תיצור כפילויות").
 */
export function createApproval(input: CreateApprovalInput): { approval: StoredApproval; created: boolean } {
  if (input.findingKey) {
    const existing = findOpenStmt.get(input.findingKey, input.kind) as unknown as Row | undefined;
    if (existing) return { approval: fromRow(existing), created: false };
  }
  const info = insertStmt.run(
    input.kind,
    input.requestedBy,
    input.managerUserKey,
    input.findingKey ?? null,
    input.itemId ?? null,
    input.itemSource ?? null,
    input.taskName ?? null,
    JSON.stringify(input.payload),
  );
  const approval = fromRow(getStmt.get(Number(info.lastInsertRowid)) as unknown as Row);
  return { approval, created: true };
}

export function getApproval(id: number): StoredApproval | null {
  const row = getStmt.get(id) as unknown as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listApprovalsForManager(managerUserKey: string, limit = 50): StoredApproval[] {
  return (listForManagerStmt.all(managerUserKey, limit) as unknown as Row[]).map(fromRow);
}

/** התפיסה האטומית — ראה הערת idempotency למעלה. true = נתפס בהצלחה ע"י הקריאה הזו. */
export function claimApproval(id: number): boolean {
  return claimStmt.run(id).changes === 1;
}

export function finalizeApproved(id: number, decisionBy: string, decisionNote: string | null): void {
  finalizeApprovedStmt.run(decisionBy, decisionNote, id);
}

/** Monday נכשל אחרי שהתפסנו — חוזרים ל-pending (לא "approved"), עם שגיאה גלויה למוטי, ניתן לנסות שוב. */
export function revertAfterFailure(id: number, executionError: string): void {
  revertAfterFailureStmt.run(executionError, id);
}

/** true = נדחה בפועל ע"י הקריאה הזו (false = כבר הוכרע קודם — לא לשלוח שוב הודעה לעובד). */
export function markRejected(id: number, decisionBy: string, decisionNote: string | null): boolean {
  return markRejectedStmt.run(decisionBy, decisionNote, id).changes === 1;
}

/** לא סופי — ה-Approval נשאר actionable (עדיין אפשר לאשר/לדחות אחרי זה). */
export function markInstruction(id: number, instruction: string): boolean {
  return markInstructionStmt.run(instruction, id).changes === 1;
}

/**
 * העובד ענה על שאלה/הנחיה — pending_instruction → pending ("הכדור חזר למוטי"). true = הצליח
 * (השורה הייתה עדיין pending_instruction). false = לא — כבר טופל/הוכרע בינתיים, לא לשמור תשובה
 * כאילו היא ה"רשמית".
 */
export function returnToPendingAfterReply(id: number): boolean {
  return returnToPendingStmt.run(id).changes === 1;
}

/** לא בשימוש עדיין — מוכן לשלב הבא (למשל: ממצא נסגר בדרך אחרת בזמן שהאישור עדיין פתוח). */
export function supersedeApproval(id: number): boolean {
  return supersedeStmt.run(id).changes === 1;
}

/**
 * להריץ פעם אחת ב-startup (לא scheduler — חד-פעמי, כמו catch-up של scheduler.ts). מחזיר כמה
 * שורות שוחזרו. קריאה עם import של db.ts בלבד (סקריפט בדיקה/CLI) לא מפעילה את זה לבד —
 * זו קריאה מפורשת, לא side-effect של import, כדי לא להפריע לבדיקות שבודקות מצב תקוע בכוונה.
 */
export function recoverStuckApprovals(): number {
  return Number(recoverStuckStmt.run().changes);
}
