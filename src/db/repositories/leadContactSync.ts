/**
 * תור סנכרון פרטי קשר מליד לאיש הקשר המקושר (lead_contact_sync). idem_key ייחודי: אותה בקשה (טופס / עדכון)
 * לא נכנסת פעמיים. next_attempt_ms הוא ה-backoff; claim אטומי דוחה את next_attempt_ms קדימה כך ששני סבבים
 * חופפים (או ריסטרט באמצע) לא מטפלים באותה משימה במקביל.
 */

import { db } from "../db.js";

export type SyncStatus = "pending" | "done" | "gave_up";
export type SyncSource = "form_create" | "lead_update";

export interface SyncChange {
  /** הערך הקודם בליד (null = לא היה / לא ידוע) — איש הקשר מעודכן רק אם הוא עדיין שווה לו או ריק */
  old: string | null;
  new: string;
}
export interface SyncFields {
  whatsapp?: SyncChange;
  phone?: SyncChange;
  email?: SyncChange;
  /** שם איש הקשר (פרטי + משפחה) */
  name?: SyncChange;
}

export interface SyncJob {
  id: number;
  idemKey: string;
  leadItemId: string;
  leadName: string | null;
  userKey: string | null;
  source: SyncSource;
  fields: SyncFields;
  status: SyncStatus;
  attempts: number;
  nextAttemptMs: number;
  lastResult: string | null;
  createdMs: number;
}

interface Raw {
  id: number;
  idem_key: string;
  lead_item_id: string;
  lead_name: string | null;
  user_key: string | null;
  source: string;
  fields_json: string;
  status: string;
  attempts: number;
  next_attempt_ms: number;
  last_result: string | null;
  created_ms: number;
}

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO lead_contact_sync (idem_key, lead_item_id, lead_name, user_key, source, fields_json, next_attempt_ms, created_ms, updated_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const dueStmt = db.prepare(
  `SELECT * FROM lead_contact_sync WHERE status = 'pending' AND next_attempt_ms <= ? ORDER BY next_attempt_ms LIMIT ?`,
);
const claimStmt = db.prepare(
  `UPDATE lead_contact_sync SET next_attempt_ms = ?, updated_ms = ? WHERE id = ? AND status = 'pending' AND next_attempt_ms <= ?`,
);
const getStmt = db.prepare(`SELECT * FROM lead_contact_sync WHERE id = ?`);
const getByKeyStmt = db.prepare(`SELECT * FROM lead_contact_sync WHERE idem_key = ?`);
const retryStmt = db.prepare(
  `UPDATE lead_contact_sync SET attempts = attempts + 1, next_attempt_ms = ?, last_result = ?, updated_ms = ? WHERE id = ? AND status = 'pending'`,
);
const finishStmt = db.prepare(
  `UPDATE lead_contact_sync SET status = ?, attempts = attempts + 1, last_result = ?, updated_ms = ? WHERE id = ? AND status = 'pending'`,
);

function fromRaw(r: Raw): SyncJob {
  return {
    id: r.id,
    idemKey: r.idem_key,
    leadItemId: r.lead_item_id,
    leadName: r.lead_name,
    userKey: r.user_key,
    source: r.source as SyncSource,
    fields: JSON.parse(r.fields_json) as SyncFields,
    status: r.status as SyncStatus,
    attempts: r.attempts,
    nextAttemptMs: r.next_attempt_ms,
    lastResult: r.last_result,
    createdMs: r.created_ms,
  };
}

/** true אם נוצרה משימה חדשה; false אם אותו idem_key כבר קיים (אין כפילות). */
export function enqueueLeadContactSync(input: {
  idemKey: string;
  leadItemId: string;
  leadName?: string | null;
  userKey?: string | null;
  source: SyncSource;
  fields: SyncFields;
  nowMs?: number;
}): boolean {
  const now = input.nowMs ?? Date.now();
  const res = insertStmt.run(
    input.idemKey,
    input.leadItemId,
    input.leadName ?? null,
    input.userKey ?? null,
    input.source,
    JSON.stringify(input.fields),
    now,
    now,
    now,
  );
  return Number(res.changes) === 1;
}

export function listDueSyncJobs(nowMs: number, limit = 20): SyncJob[] {
  return (dueStmt.all(nowMs, limit) as unknown as Raw[]).map(fromRaw);
}

/** תופס משימה לטיפול: דוחה את next_attempt_ms ב-leaseMs. false = מישהו אחר כבר תפס / לא בשל. */
export function claimSyncJob(id: number, nowMs: number, leaseMs: number): boolean {
  return Number(claimStmt.run(nowMs + leaseMs, nowMs, id, nowMs).changes) === 1;
}

export function rescheduleSyncJob(id: number, nextAttemptMs: number, lastResult: string, nowMs: number): void {
  retryStmt.run(nextAttemptMs, lastResult.slice(0, 500), nowMs, id);
}

export function finishSyncJob(id: number, status: "done" | "gave_up", lastResult: string, nowMs: number): void {
  finishStmt.run(status, lastResult.slice(0, 500), nowMs, id);
}

export function getSyncJob(id: number): SyncJob | null {
  const r = getStmt.get(id) as unknown as Raw | undefined;
  return r ? fromRaw(r) : null;
}

export function getSyncJobByKey(idemKey: string): SyncJob | null {
  const r = getByKeyStmt.get(idemKey) as unknown as Raw | undefined;
  return r ? fromRaw(r) : null;
}
