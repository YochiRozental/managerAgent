/**
 * מקטעי טיימר משימה — גישה ל-DB בלבד (task_timer_segments / task_timer_state). אפס לוגיקה עסקית:
 * ר' ops/taskTimer.ts. כל הפונקציות סינכרוניות (node:sqlite). הכתיבות שצריכות אטומיות עטופות
 * בטרנזקציה אצל הקורא (runInTransaction) — כאן רק statements.
 */

import { db } from "../db.js";

export type TimerEndReason = "stopped" | "done" | "switched" | "day_close" | "stale";

export interface TimerSegment {
  id: number;
  userKey: string;
  workDate: string;
  itemId: string;
  itemSource: string;
  taskName: string;
  projectId: string | null;
  projectName: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: TimerEndReason | null;
  idempotencyKey: string;
  endIdempotencyKey: string | null;
}

interface Row {
  id: number;
  user_key: string;
  work_date: string;
  item_id: string;
  item_source: string;
  task_name: string;
  project_id: string | null;
  project_name: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  idempotency_key: string;
  end_idempotency_key: string | null;
}

function fromRow(r: Row): TimerSegment {
  return {
    id: r.id,
    userKey: r.user_key,
    workDate: r.work_date,
    itemId: r.item_id,
    itemSource: r.item_source,
    taskName: r.task_name,
    projectId: r.project_id,
    projectName: r.project_name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    endReason: r.end_reason as TimerEndReason | null,
    idempotencyKey: r.idempotency_key,
    endIdempotencyKey: r.end_idempotency_key,
  };
}

const activeStmt = db.prepare(`SELECT * FROM task_timer_segments WHERE user_key = ? AND ended_at IS NULL`);
const byKeyStmt = db.prepare(`SELECT * FROM task_timer_segments WHERE idempotency_key = ?`);
const byEndKeyStmt = db.prepare(`SELECT * FROM task_timer_segments WHERE end_idempotency_key = ?`);
const getStmt = db.prepare(`SELECT * FROM task_timer_segments WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO task_timer_segments
     (user_key, work_date, item_id, item_source, task_name, project_id, project_name, started_at, idempotency_key)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const endStmt = db.prepare(
  `UPDATE task_timer_segments SET ended_at = ?, end_reason = ?, end_idempotency_key = ? WHERE id = ? AND ended_at IS NULL`,
);
const listOpenStmt = db.prepare(`SELECT * FROM task_timer_segments WHERE ended_at IS NULL`);
const listDateStmt = db.prepare(`SELECT * FROM task_timer_segments WHERE user_key = ? AND work_date = ? ORDER BY started_at ASC`);
const listRangeStmt = db.prepare(
  `SELECT * FROM task_timer_segments WHERE user_key = ? AND work_date >= ? AND work_date <= ? ORDER BY started_at ASC`,
);
const lastStoppedStmt = db.prepare(
  `SELECT * FROM task_timer_segments
    WHERE user_key = ? AND work_date = ? AND ended_at IS NOT NULL AND end_reason IN ('stopped','switched')
    ORDER BY ended_at DESC, id DESC LIMIT 1`,
);
const dayCloseSegmentsStmt = db.prepare(
  `SELECT * FROM task_timer_segments
    WHERE user_key = ? AND work_date = ? AND (ended_at IS NULL OR end_reason IN ('day_close','stale'))`,
);
const setEndStmt = db.prepare(`UPDATE task_timer_segments SET ended_at = ?, end_reason = ? WHERE id = ?`);

export function getActiveSegment(userKey: string): TimerSegment | null {
  const r = activeStmt.get(userKey) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export function getSegmentByIdempotencyKey(key: string): TimerSegment | null {
  const r = byKeyStmt.get(key) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export function getSegmentByEndKey(key: string): TimerSegment | null {
  const r = byEndKeyStmt.get(key) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export function getSegment(id: number): TimerSegment | null {
  const r = getStmt.get(id) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export interface InsertSegmentInput {
  userKey: string;
  workDate: string;
  itemId: string;
  itemSource: string;
  taskName: string;
  projectId: string | null;
  projectName: string | null;
  startedAt: string;
  idempotencyKey: string;
}

/** זורק על הפרת האינדקס החלקי (כבר יש טיימר פעיל) או על idempotency_key קיים — הקורא בודק לפני. */
export function insertSegment(input: InsertSegmentInput): TimerSegment {
  insertStmt.run(
    input.userKey,
    input.workDate,
    input.itemId,
    input.itemSource,
    input.taskName,
    input.projectId,
    input.projectName,
    input.startedAt,
    input.idempotencyKey,
  );
  return getSegmentByIdempotencyKey(input.idempotencyKey)!;
}

/** סוגר מקטע פתוח (CAS על ended_at IS NULL). true ⇔ אכן נסגר עכשיו. */
export function endSegment(id: number, endedAt: string, reason: TimerEndReason, endKey: string | null): boolean {
  return Number(endStmt.run(endedAt, reason, endKey, id).changes) > 0;
}

export function listOpenSegments(): TimerSegment[] {
  return (listOpenStmt.all() as unknown as Row[]).map(fromRow);
}

export function listSegmentsForDate(userKey: string, workDate: string): TimerSegment[] {
  return (listDateStmt.all(userKey, workDate) as unknown as Row[]).map(fromRow);
}

export function listSegmentsInRange(userKey: string, fromDate: string, toDate: string): TimerSegment[] {
  return (listRangeStmt.all(userKey, fromDate, toDate) as unknown as Row[]).map(fromRow);
}

export function getLastStoppedSegment(userKey: string, workDate: string): TimerSegment | null {
  const r = lastStoppedStmt.get(userKey, workDate) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

/** מקטעים של יום שצריכים יישור לשעת הסגירה: פתוחים, או כאלה שנסגרו קודם ע"י סגירת יום/stale. */
export function listSegmentsNeedingDayCloseAlignment(userKey: string, workDate: string): TimerSegment[] {
  return (dayCloseSegmentsStmt.all(userKey, workDate) as unknown as Row[]).map(fromRow);
}

/** עדכון שעת סיום של מקטע שנסגר ע"י סגירת יום (תיקון רטרואקטיבי של שעת הסגירה ממשיך לעבוד). */
export function realignSegmentEnd(id: number, endedAt: string, reason: TimerEndReason): void {
  setEndStmt.run(endedAt, reason, id);
}

// ── מצב עזר ───────────────────────────────────────────────────────────────────

export interface TimerState {
  userKey: string;
  lastReminderAt: string | null;
  pending: { itemId: string; itemSource: string; taskName: string; projectId: string | null; projectName: string | null; expiresAt: string } | null;
}

interface StateRow {
  user_key: string;
  last_reminder_at: string | null;
  pending_item_id: string | null;
  pending_item_source: string | null;
  pending_task_name: string | null;
  pending_project_id: string | null;
  pending_project_name: string | null;
  pending_expires_at: string | null;
}

const getStateStmt = db.prepare(`SELECT * FROM task_timer_state WHERE user_key = ?`);
const ensureStateStmt = db.prepare(`INSERT OR IGNORE INTO task_timer_state (user_key) VALUES (?)`);
const setPendingStmt = db.prepare(
  `UPDATE task_timer_state SET pending_item_id = ?, pending_item_source = ?, pending_task_name = ?, pending_project_id = ?,
     pending_project_name = ?, pending_expires_at = ?, updated_at = datetime('now') WHERE user_key = ?`,
);
const clearPendingStmt = db.prepare(
  `UPDATE task_timer_state SET pending_item_id = NULL, pending_item_source = NULL, pending_task_name = NULL,
     pending_project_id = NULL, pending_project_name = NULL, pending_expires_at = NULL, updated_at = datetime('now') WHERE user_key = ?`,
);
const setReminderStmt = db.prepare(`UPDATE task_timer_state SET last_reminder_at = ?, updated_at = datetime('now') WHERE user_key = ?`);

export function getTimerState(userKey: string): TimerState {
  const r = getStateStmt.get(userKey) as unknown as StateRow | undefined;
  return {
    userKey,
    lastReminderAt: r?.last_reminder_at ?? null,
    pending:
      r?.pending_item_id && r.pending_expires_at
        ? {
            itemId: r.pending_item_id,
            itemSource: r.pending_item_source ?? "general",
            taskName: r.pending_task_name ?? "",
            projectId: r.pending_project_id,
            projectName: r.pending_project_name,
            expiresAt: r.pending_expires_at,
          }
        : null,
  };
}

export function setPendingSwitch(
  userKey: string,
  p: { itemId: string; itemSource: string; taskName: string; projectId: string | null; projectName: string | null; expiresAt: string },
): void {
  ensureStateStmt.run(userKey);
  setPendingStmt.run(p.itemId, p.itemSource, p.taskName, p.projectId, p.projectName, p.expiresAt, userKey);
}

export function clearPendingSwitch(userKey: string): void {
  clearPendingStmt.run(userKey);
}

export function setLastReminderAt(userKey: string, iso: string): void {
  ensureStateStmt.run(userKey);
  setReminderStmt.run(iso, userKey);
}
