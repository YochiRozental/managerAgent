import { db } from "../db.js";

/**
 * מצב מערכת — פעימות לב פר-תהליך + ריצות עבודות מתוזמנות.
 * מזין את /health ואת ה-catch-up של המתזמן. אין כאן לוגיקה — רק קריאה/כתיבה.
 */

// ---- heartbeats ----

const beatStmt = db.prepare(
  `INSERT INTO heartbeats (process, beat_at, pid, detail)
   VALUES (?, datetime('now'), ?, ?)
   ON CONFLICT(process) DO UPDATE SET beat_at = excluded.beat_at, pid = excluded.pid, detail = excluded.detail`,
);
const allBeatsStmt = db.prepare(`SELECT process, beat_at, pid, detail FROM heartbeats`);

export interface Heartbeat {
  process: string;
  beatAt: string;
  pid: number | null;
  detail: string | null;
}

/** תהליך מדווח "אני חי". נקרא כל דקה מכל תהליך. */
export function recordHeartbeat(name: string, detail?: string): void {
  beatStmt.run(name, typeof process.pid === "number" ? process.pid : null, detail ?? null);
}

export function listHeartbeats(): Heartbeat[] {
  return (allBeatsStmt.all() as unknown as {
    process: string;
    beat_at: string;
    pid: number | null;
    detail: string | null;
  }[]).map((r) => ({ process: r.process, beatAt: r.beat_at, pid: r.pid, detail: r.detail }));
}

// ---- job_runs ----

const startJobStmt = db.prepare(
  `INSERT INTO job_runs (job, trigger) VALUES (?, ?)`,
);
const finishJobStmt = db.prepare(
  `UPDATE job_runs SET finished_at = datetime('now'), ok = ?, error = ? WHERE id = ?`,
);
const lastRunStmt = db.prepare(
  `SELECT * FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1`,
);
const lastOkStmt = db.prepare(
  `SELECT * FROM job_runs WHERE job = ? AND ok = 1 ORDER BY id DESC LIMIT 1`,
);
const runsOnDateStmt = db.prepare(
  `SELECT COUNT(*) AS c FROM job_runs WHERE job = ? AND substr(started_at, 1, 10) = ?`,
);

export type JobTrigger = "schedule" | "catchup" | "manual";

export interface JobRun {
  id: number;
  job: string;
  startedAt: string;
  finishedAt: string | null;
  ok: number | null;
  trigger: string | null;
  error: string | null;
}

interface JobRow {
  id: number;
  job: string;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  trigger: string | null;
  error: string | null;
}

function fromJobRow(r: JobRow): JobRun {
  return {
    id: r.id,
    job: r.job,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: r.ok,
    trigger: r.trigger,
    error: r.error,
  };
}

export function startJobRun(job: string, trigger: JobTrigger): number {
  const info = startJobStmt.run(job, trigger);
  return Number(info.lastInsertRowid);
}

export function finishJobRun(id: number, ok: boolean, error?: string): void {
  finishJobStmt.run(ok ? 1 : 0, error ?? null, id);
}

export function lastJobRun(job: string): JobRun | null {
  const r = lastRunStmt.get(job) as unknown as JobRow | undefined;
  return r ? fromJobRow(r) : null;
}

export function lastSuccessfulJobRun(job: string): JobRun | null {
  const r = lastOkStmt.get(job) as unknown as JobRow | undefined;
  return r ? fromJobRow(r) : null;
}

/** כמה פעמים העבודה כבר הותנעה בתאריך הזה (YYYY-MM-DD, אזור זמן מקומי של הקורא). */
export function jobRunCountOn(job: string, isoDate: string): number {
  const r = runsOnDateStmt.get(job, isoDate) as unknown as { c: number };
  return r.c;
}
