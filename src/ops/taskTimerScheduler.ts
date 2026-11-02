/**
 * סריקת תחזוקה שעתית למדידת זמן על משימות. כבויה לגמרי כש-TASK_TIMER_ENABLED=false (בודקת את עצמה —
 * חיווט מ-scheduler.ts בטוח גם לפני הפעלה). סוגרת מקטעים פתוחים על ימי נוכחות שכבר נסגרו / ימים קודמים
 * (למקרה ש-hook הסגירה לא רץ) ומתריעה ביומן על טיימר שרץ זמן חריג. אינה משנה שום חישוב שעות.
 * נרשמת ב-job_runs כמו שאר העבודות המתוזמנות (נראה ב-/health).
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { finishJobRun, startJobRun } from "../db/repositories/systemHealth.js";
import { logger } from "../utils/logger.js";
import { sweepTaskTimers } from "./taskTimer.js";

const JOB_KEY = "task_timer_sweep";
const TICK_MS = 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inProgress = false;

export function runTaskTimerSweepTick(now: DateTime = DateTime.now().setZone(env.TIMEZONE)): void {
  if (inProgress) return;
  inProgress = true;
  const runId = startJobRun(JOB_KEY, "schedule");
  try {
    const r = sweepTaskTimers(now);
    finishJobRun(runId, true);
    if (r.reconciled > 0 || r.longRunning > 0) logger.info({ ...r }, "sweep טיימרי משימות: טופלו מקטעים פתוחים");
  } catch (err) {
    finishJobRun(runId, false, (err as Error).message);
    logger.error({ err }, "sweep טיימרי משימות נכשל — הסבב הבא ינסה שוב");
  } finally {
    inProgress = false;
  }
}

export function startTaskTimerSweepSchedule(): void {
  if (timer) return;
  if (!env.TASK_TIMER_ENABLED) {
    logger.info("מדידת זמן משימות כבויה (TASK_TIMER_ENABLED=false) — sweep לא מופעל.");
    return;
  }
  runTaskTimerSweepTick(); // התאוששות מיידית אחרי ריסטרט
  timer = setInterval(() => runTaskTimerSweepTick(), TICK_MS);
}

export function stopTaskTimerSweepSchedule(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
