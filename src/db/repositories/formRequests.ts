/**
 * בקשות טופס יצירה בצ'אט (form_requests). ה-id הוא מפתח ה-idempotency של היצירה: claimForSubmit הוא
 * מעבר אטומי open → submitting, ולכן שתי לחיצות/בקשות מקבילות על אותו טופס — רק אחת מבצעת.
 * submitting שנתקע (קריסת שרת באמצע) ניתן לתפיסה מחדש אחרי STALE_SUBMIT_SECONDS.
 */

import { db } from "../db.js";

export type FormStatus = "open" | "submitting" | "submitted" | "cancelled";

export interface FormRequestRow {
  id: string;
  userKey: string;
  sessionId: string | null;
  kind: string;
  status: FormStatus;
  prefillJson: string;
  resultJson: string | null;
  lastError: string | null;
  createdAt: string;
  /** כמה פעמים הטופס נתפס לשליחה. >1 = ייתכן שניסיון קודם כבר יצר את הפריט ב-Monday (ר' service.ts) */
  attempts: number;
  firstAttemptMs: number | null;
  /** הפריט שנוצר + שלבי המשך שהושלמו (JSON); נכתב מיד אחרי היצירה, לפני כל שלב המשך */
  checkpointJson: string | null;
}

interface Raw {
  id: string;
  user_key: string;
  session_id: string | null;
  kind: string;
  status: string;
  prefill_json: string;
  result_json: string | null;
  last_error: string | null;
  created_at: string;
  attempts: number;
  first_attempt_ms: number | null;
  checkpoint_json: string | null;
}

export const STALE_SUBMIT_SECONDS = 120;

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO form_requests (id, user_key, session_id, kind, prefill_json) VALUES (?, ?, ?, ?, ?)`,
);
const getStmt = db.prepare(`SELECT * FROM form_requests WHERE id = ?`);
const claimStmt = db.prepare(
  `UPDATE form_requests SET status = 'submitting', updated_at = datetime('now'),
          attempts = attempts + 1, first_attempt_ms = COALESCE(first_attempt_ms, ?)
   WHERE id = ? AND user_key = ?
     AND (status = 'open' OR (status = 'submitting' AND updated_at < datetime('now', ?)))`,
);
const submittedStmt = db.prepare(
  `UPDATE form_requests SET status = 'submitted', result_json = ?, last_error = NULL, updated_at = datetime('now')
   WHERE id = ? AND status = 'submitting'`,
);
const releaseStmt = db.prepare(
  `UPDATE form_requests SET status = 'open', last_error = ?, updated_at = datetime('now')
   WHERE id = ? AND status = 'submitting'`,
);
const checkpointStmt = db.prepare(`UPDATE form_requests SET checkpoint_json = ?, updated_at = datetime('now') WHERE id = ?`);
const byItemStmt = db.prepare(`SELECT id FROM form_requests WHERE checkpoint_json LIKE ? AND id != ? LIMIT 1`);
const cancelStmt = db.prepare(
  `UPDATE form_requests SET status = 'cancelled', updated_at = datetime('now')
   WHERE id = ? AND user_key = ? AND status = 'open'`,
);

function fromRaw(r: Raw): FormRequestRow {
  return {
    id: r.id,
    userKey: r.user_key,
    sessionId: r.session_id,
    kind: r.kind,
    status: r.status as FormStatus,
    prefillJson: r.prefill_json,
    resultJson: r.result_json,
    lastError: r.last_error,
    createdAt: r.created_at,
    attempts: r.attempts ?? 0,
    firstAttemptMs: r.first_attempt_ms ?? null,
    checkpointJson: r.checkpoint_json ?? null,
  };
}

/** יוצר בקשת טופס; אם ה-id כבר קיים (retry דטרמיניסטי) מחזיר את הקיימת בלי לשנות אותה. */
export function createFormRequest(input: {
  id: string;
  userKey: string;
  sessionId: string | null;
  kind: string;
  prefill: unknown;
}): FormRequestRow {
  insertStmt.run(input.id, input.userKey, input.sessionId, input.kind, JSON.stringify(input.prefill));
  return getFormRequest(input.id)!;
}

export function getFormRequest(id: string): FormRequestRow | null {
  const r = getStmt.get(id) as unknown as Raw | undefined;
  return r ? fromRaw(r) : null;
}

/** true רק למי שתפס בפועל את הזכות לבצע את היצירה. */
export function claimFormForSubmit(id: string, userKey: string): boolean {
  const res = claimStmt.run(Date.now(), id, userKey, `-${STALE_SUBMIT_SECONDS} seconds`);
  return Number(res.changes) === 1;
}

/** שומר מיד אחרי שהפריט נוצר (לפני כל שלב המשך) — כדי שקריסה/ניתוק לא יגרמו ליצירה שנייה. */
export function saveFormCheckpoint(id: string, checkpoint: unknown): void {
  checkpointStmt.run(JSON.stringify(checkpoint), id);
}

/** מזהה הטופס (אחר מ-exceptId) שיצר את הפריט הזה — כדי שהתאמת-מצב לא תאמץ פריט של טופס אחר. */
export function findFormByCreatedItem(itemId: string, exceptId: string): string | null {
  const r = byItemStmt.get(`%"itemId":"${itemId}"%`, exceptId) as { id: string } | undefined;
  return r?.id ?? null;
}

export function markFormSubmitted(id: string, result: unknown): void {
  submittedStmt.run(JSON.stringify(result), id);
}

/** כשל ביצירה — הטופס חוזר להיות פתוח (המשתמש יכול לתקן ולנסות שוב) עם הודעת השגיאה. */
export function releaseFormToOpen(id: string, error: string): void {
  releaseStmt.run(error.slice(0, 500), id);
}

export function cancelFormRequest(id: string, userKey: string): boolean {
  return Number(cancelStmt.run(id, userKey).changes) === 1;
}
