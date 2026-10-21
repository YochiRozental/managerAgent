/**
 * אחסון קבוצות תוצאות ותוכניות עדכון קבוצתי (ר' schema.sql — bulk_result_sets / bulk_plans,
 * ו-src/ops/bulkUpdate.ts לזרימה המלאה). כל הקריאות ממודרות ל-user_key+session_id — משתמש אחד
 * לא יכול להגיע לקבוצה/תוכנית של אחר גם אם המודל "ממציא" מזהה.
 */

import { randomUUID } from "node:crypto";
import { db } from "../db.js";

export type BulkPlanStatus = "awaiting_confirmation" | "executing" | "executed" | "stale" | "cancelled" | "expired";

export interface StoredResultSet {
  id: string;
  userKey: string;
  sessionId: string;
  recordType: string;
  filters: unknown;
  filtersText: string;
  records: { itemId: string; kind: string; name: string }[];
  complete: boolean;
  createdAt: string;
}

export interface StoredBulkPlan {
  id: string;
  userKey: string;
  sessionId: string;
  resultSetId: string;
  recordType: string;
  change: unknown;
  changeText: string;
  items: unknown;
  status: BulkPlanStatus;
  createdTurn: string;
  expiresAt: string;
  report: unknown | null;
  createdAt: string;
}

interface ResultSetRow {
  id: string;
  user_key: string;
  session_id: string;
  record_type: string;
  filters_json: string;
  filters_text: string;
  records_json: string;
  complete: number;
  created_at: string;
}

interface PlanRow {
  id: string;
  user_key: string;
  session_id: string;
  result_set_id: string;
  record_type: string;
  change_json: string;
  change_text: string;
  items_json: string;
  status: BulkPlanStatus;
  created_turn: string;
  expires_at: string;
  report_json: string | null;
  created_at: string;
}

function toResultSet(r: ResultSetRow): StoredResultSet {
  return {
    id: r.id,
    userKey: r.user_key,
    sessionId: r.session_id,
    recordType: r.record_type,
    filters: JSON.parse(r.filters_json),
    filtersText: r.filters_text,
    records: JSON.parse(r.records_json),
    complete: r.complete === 1,
    createdAt: r.created_at,
  };
}

function toPlan(r: PlanRow): StoredBulkPlan {
  return {
    id: r.id,
    userKey: r.user_key,
    sessionId: r.session_id,
    resultSetId: r.result_set_id,
    recordType: r.record_type,
    change: JSON.parse(r.change_json),
    changeText: r.change_text,
    items: JSON.parse(r.items_json),
    status: r.status,
    createdTurn: r.created_turn,
    expiresAt: r.expires_at,
    report: r.report_json ? JSON.parse(r.report_json) : null,
    createdAt: r.created_at,
  };
}

const insertResultSetStmt = db.prepare(
  `INSERT INTO bulk_result_sets (id, user_key, session_id, record_type, filters_json, filters_text, records_json, complete)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const getResultSetStmt = db.prepare(`SELECT * FROM bulk_result_sets WHERE id = ? AND user_key = ? AND session_id = ?`);
const latestResultSetStmt = db.prepare(
  `SELECT * FROM bulk_result_sets WHERE user_key = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
);

export function saveResultSet(input: {
  userKey: string;
  sessionId: string;
  recordType: string;
  filters: unknown;
  filtersText: string;
  records: { itemId: string; kind: string; name: string }[];
  complete: boolean;
}): string {
  const id = `rs_${randomUUID().slice(0, 8)}`;
  insertResultSetStmt.run(
    id,
    input.userKey,
    input.sessionId,
    input.recordType,
    JSON.stringify(input.filters),
    input.filtersText,
    JSON.stringify(input.records),
    input.complete ? 1 : 0,
  );
  return id;
}

export function getResultSet(id: string, userKey: string, sessionId: string): StoredResultSet | null {
  const row = getResultSetStmt.get(id, userKey, sessionId) as unknown as ResultSetRow | undefined;
  return row ? toResultSet(row) : null;
}

export function getLatestResultSet(userKey: string, sessionId: string): StoredResultSet | null {
  const row = latestResultSetStmt.get(userKey, sessionId) as unknown as ResultSetRow | undefined;
  return row ? toResultSet(row) : null;
}

const insertPlanStmt = db.prepare(
  `INSERT INTO bulk_plans (id, user_key, session_id, result_set_id, record_type, change_json, change_text, items_json, status, created_turn, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?)`,
);
const getPlanStmt = db.prepare(`SELECT * FROM bulk_plans WHERE id = ? AND user_key = ? AND session_id = ?`);
const latestPendingPlanStmt = db.prepare(
  `SELECT * FROM bulk_plans WHERE user_key = ? AND session_id = ? AND status = 'awaiting_confirmation'
   ORDER BY created_at DESC, rowid DESC LIMIT 1`,
);
const supersedePendingStmt = db.prepare(
  `UPDATE bulk_plans SET status = 'cancelled', updated_at = datetime('now')
   WHERE user_key = ? AND session_id = ? AND status = 'awaiting_confirmation'`,
);
const casStatusStmt = db.prepare(
  `UPDATE bulk_plans SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?`,
);
const setReportStmt = db.prepare(`UPDATE bulk_plans SET report_json = ?, updated_at = datetime('now') WHERE id = ?`);
const finalizeStmt = db.prepare(
  `UPDATE bulk_plans SET status = ?, report_json = ?, updated_at = datetime('now') WHERE id = ?`,
);

/** יוצר תוכנית חדשה. תוכנית קודמת שעדיין ממתינה באותה שיחה מבוטלת — רק התצוגה האחרונה ניתנת לאישור. */
export function savePlan(input: {
  userKey: string;
  sessionId: string;
  resultSetId: string;
  recordType: string;
  change: unknown;
  changeText: string;
  items: unknown;
  createdTurn: string;
  expiresAt: string;
}): string {
  const id = `bp_${randomUUID().slice(0, 8)}`;
  supersedePendingStmt.run(input.userKey, input.sessionId);
  insertPlanStmt.run(
    id,
    input.userKey,
    input.sessionId,
    input.resultSetId,
    input.recordType,
    JSON.stringify(input.change),
    input.changeText,
    JSON.stringify(input.items),
    input.createdTurn,
    input.expiresAt,
  );
  return id;
}

export function getPlan(id: string, userKey: string, sessionId: string): StoredBulkPlan | null {
  const row = getPlanStmt.get(id, userKey, sessionId) as unknown as PlanRow | undefined;
  return row ? toPlan(row) : null;
}

export function getLatestPendingPlan(userKey: string, sessionId: string): StoredBulkPlan | null {
  const row = latestPendingPlanStmt.get(userKey, sessionId) as unknown as PlanRow | undefined;
  return row ? toPlan(row) : null;
}

/** compare-and-swap של סטטוס — true רק אם התוכנית הייתה בדיוק ב-`from` ועברה ל-`to`. */
export function casPlanStatus(id: string, from: BulkPlanStatus, to: BulkPlanStatus): boolean {
  return Number(casStatusStmt.run(to, id, from).changes) === 1;
}

/** שמירת התקדמות ביצוע (תוך כדי) — כדי שקריסה באמצע תשאיר תיעוד של מה כבר נכתב. */
export function savePlanProgress(id: string, report: unknown): void {
  setReportStmt.run(JSON.stringify(report), id);
}

export function finalizePlan(id: string, status: BulkPlanStatus, report: unknown): void {
  finalizeStmt.run(status, JSON.stringify(report), id);
}

/** ביטול תוכנית ממתינה של המשתמש (אם יש). מחזיר את מספר התוכניות שבוטלו. */
export function cancelPendingPlans(userKey: string, sessionId: string): number {
  return Number(supersedePendingStmt.run(userKey, sessionId).changes);
}
