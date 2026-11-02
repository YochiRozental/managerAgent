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
import { createRealTaskTimerMondayClient, type TaskTimerMondayClient } from "../integrations/monday/taskTimerMondayClient.js";
import { backfillTaskTimerSync, runTaskTimerMondaySync } from "./taskTimerSync.js";

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

// ── סנכרון "זמן עבודה מצטבר" ל-Monday ────────────────────────────────────────────
// כבוי כש-TASK_TIMER_MONDAY_SYNC_ENABLED=false. בהפעלה: backfill (מסמן הכל; ההשוואה מקומית ורק שינויים
// נכתבים ל-Monday), ואז טיק כל 5 דקות. נרשם ב-job_runs כמו שאר העבודות.

const SYNC_JOB_KEY = "task_timer_monday_sync";
const SYNC_TICK_MS = 5 * 60_000;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;

export async function runTaskTimerMondaySyncTick(client?: TaskTimerMondayClient): Promise<void> {
  if (syncInProgress) return; // הגנת overlap; ה-claim האטומי ב-DB הוא שכבת ההגנה הנוספת
  syncInProgress = true;
  const runId = startJobRun(SYNC_JOB_KEY, "schedule");
  try {
    const r = await runTaskTimerMondaySync(client ?? createRealTaskTimerMondayClient());
    finishJobRun(runId, true);
    if (r.claimed > 0 || r.requeued > 0) logger.info({ ...r }, "סנכרון זמן עבודה ל-Monday: סבב הושלם");
  } catch (err) {
    finishJobRun(runId, false, (err as Error).message);
    logger.error({ err }, "סנכרון זמן עבודה ל-Monday: כשל בלתי-צפוי בסבב — הטיק הבא ינסה שוב");
  } finally {
    syncInProgress = false;
  }
}

export function startTaskTimerMondaySyncSchedule(): void {
  if (syncTimer) return;
  if (!env.TASK_TIMER_MONDAY_SYNC_ENABLED) {
    logger.info("סנכרון זמן משימות ל-Monday כבוי (TASK_TIMER_MONDAY_SYNC_ENABLED=false) — לא מופעל.");
    return;
  }
  try {
    const marked = backfillTaskTimerSync();
    logger.info({ marked }, "סנכרון זמן משימות ל-Monday הופעל — backfill סימן פריטים קיימים");
  } catch (err) {
    logger.error({ err }, "backfill של סנכרון זמן משימות נכשל — הסימונים השוטפים ימשיכו כרגיל");
  }
  void runTaskTimerMondaySyncTick();
  syncTimer = setInterval(() => void runTaskTimerMondaySyncTick(), SYNC_TICK_MS);
}

export function stopTaskTimerMondaySyncSchedule(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
