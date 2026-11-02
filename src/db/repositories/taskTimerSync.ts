/**
 * תור סנכרון "זמן עבודה מצטבר" ל-Monday — גישה ל-DB בלבד (task_timer_sync). הלוגיקה ב-ops/taskTimerSync.ts.
 * כל הפונקציות סינכרוניות וללא טרנזקציה משלהן (נקראות גם מתוך runInTransaction של הנוכחות/הטיימר).
 */

import { db } from "../db.js";

export type SyncStatus = "dirty" | "syncing" | "synced" | "failed" | "dead";

export interface SyncRow {
  itemId: string;
  itemSource: string;
  status: SyncStatus;
  version: number;
  claimedVersion: number | null;
  claimId: string | null;
  claimedAt: string | null;
  lastValue: number | null;
  lastMs: number | null;
  lastDisplay: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  lastSyncedAt: string | null;
}

interface Row {
  item_id: string;
  item_source: string;
  status: string;
  version: number;
  claimed_version: number | null;
  claim_id: string | null;
  claimed_at: string | null;
  last_value: number | null;
  last_ms: number | null;
  last_display: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  last_synced_at: string | null;
}

const fromRow = (r: Row): SyncRow => ({
  itemId: r.item_id,
  itemSource: r.item_source,
  status: r.status as SyncStatus,
  version: r.version,
  claimedVersion: r.claimed_version,
  claimId: r.claim_id,
  claimedAt: r.claimed_at,
  lastValue: r.last_value,
  lastMs: r.last_ms,
  lastDisplay: r.last_display,
  attempts: r.attempts,
  lastError: r.last_error,
  nextAttemptAt: r.next_attempt_at,
  lastSyncedAt: r.last_synced_at,
});

// UPSERT: version תמיד עולה. מצב syncing נשאר (הסנכרון בדרך יראה version חדש ויחזיר ל-dirty);
// dead חוזר ל-dirty עם attempts מאופס (שינוי חדש = סיבה לנסות שוב).
const markStmt = db.prepare(
  `INSERT INTO task_timer_sync (item_id, item_source, status, version) VALUES (?, ?, 'dirty', 1)
   ON CONFLICT(item_id) DO UPDATE SET
     item_source = excluded.item_source,
     version = version + 1,
     status = CASE WHEN status = 'syncing' THEN 'syncing' ELSE 'dirty' END,
     attempts = CASE WHEN status = 'dead' THEN 0 ELSE attempts END,
     next_attempt_at = CASE WHEN status = 'syncing' THEN next_attempt_at ELSE NULL END,
     updated_at = datetime('now')`,
);
const getStmt = db.prepare(`SELECT * FROM task_timer_sync WHERE item_id = ?`);
const dueStmt = db.prepare(
  `SELECT item_id FROM task_timer_sync
    WHERE status IN ('dirty','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY updated_at ASC LIMIT ?`,
);
const claimStmt = db.prepare(
  `UPDATE task_timer_sync SET status = 'syncing', claim_id = ?, claimed_at = ?, claimed_version = version, updated_at = datetime('now')
    WHERE item_id = ? AND status IN ('dirty','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
);
const completeStmt = db.prepare(
  `UPDATE task_timer_sync SET
      status = CASE WHEN version = claimed_version THEN 'synced' ELSE 'dirty' END,
      last_value = ?, last_ms = ?, last_display = ?, attempts = 0, last_error = NULL, next_attempt_at = NULL,
      last_synced_at = ?, claim_id = NULL, claimed_at = NULL, updated_at = datetime('now')
    WHERE item_id = ? AND claim_id = ?`,
);
const failStmt = db.prepare(
  `UPDATE task_timer_sync SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
      claim_id = NULL, claimed_at = NULL, updated_at = datetime('now')
    WHERE item_id = ? AND claim_id = ?`,
);
const recoverStmt = db.prepare(
  `UPDATE task_timer_sync SET status = 'dirty', claim_id = NULL, claimed_at = NULL, updated_at = datetime('now')
    WHERE status = 'syncing' AND (claimed_at IS NULL OR claimed_at < ?)`,
);
const countStmt = db.prepare(`SELECT status, COUNT(*) AS n FROM task_timer_sync GROUP BY status`);

export function markDirty(itemId: string, itemSource: string): void {
  markStmt.run(itemId, itemSource);
}

export function getSyncRow(itemId: string): SyncRow | null {
  const r = getStmt.get(itemId) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export function listDueItemIds(nowIso: string, limit: number): string[] {
  return (dueStmt.all(nowIso, limit) as unknown as { item_id: string }[]).map((r) => r.item_id);
}

/** CAS: true ⇔ ה-claim הצליח (רק dirty/failed שהגיע זמנו). claimed_version = version ברגע התפיסה. */
export function claimItem(itemId: string, claimId: string, nowIso: string): boolean {
  return Number(claimStmt.run(claimId, nowIso, itemId, nowIso).changes) > 0;
}

/** true ⇔ ה-claim עדיין שלנו. synced רק אם version לא השתנה מאז ה-claim; אחרת חוזר ל-dirty. */
export function completeSync(itemId: string, claimId: string, value: number, ms: number, display: string, nowIso: string): boolean {
  return Number(completeStmt.run(value, Math.round(ms), display, nowIso, itemId, claimId).changes) > 0;
}

export function failSync(itemId: string, claimId: string, status: "failed" | "dead", error: string, nextAttemptAt: string | null): boolean {
  return Number(failStmt.run(status, error.slice(0, 500), nextAttemptAt, itemId, claimId).changes) > 0;
}

/** claim שנתקע (קריסה באמצע) → חוזר ל-dirty. מחזיר כמה שוחזרו. */
export function recoverStuckClaims(olderThanIso: string): number {
  return Number(recoverStmt.run(olderThanIso).changes);
}

export function countByStatus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of countStmt.all() as unknown as { status: string; n: number }[]) out[r.status] = r.n;
  return out;
}
