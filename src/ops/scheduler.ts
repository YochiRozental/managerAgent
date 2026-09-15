/**
 * מתזמן את הסבבים היזומים של מנוע הבקרה — רץ בתוך שרת החלונית (התהליך שתמיד למעלה תחת PM2/Docker).
 *   • גיבוי DB  — BACKUP_HOUR (ברירת מחדל 6:00), כל יום
 *   • סבב יומי  — CONTROL_SCAN_HOUR (ברירת מחדל 7:00), א׳–ה׳
 *   • דוח שבועי — WEEKLY_REPORT_HOUR (ברירת מחדל 8:00), יום א׳
 *   • Follow-up Engine — כל FOLLOWUP_SCHEDULE_CONFIG.intervalMinutes דקות, בתוך חלון העבודה בלבד
 *     (ראה למטה) — שונה מהותית מהעבודות למעלה (unce-a-day בשעה קבועה), ולכן לא באותו מנגנון JOBS.
 *
 * catch-up: אם השרת עלה מחדש אחרי השעה המתוזמנת ועבודה של היום עוד לא הותנעה — מריצים אותה מיד.
 * כל ריצה נרשמת ב-job_runs (זמן, הצלחה/כישלון, טריגר) — מזין את /health ואת ה-catch-up.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  finishJobRun,
  jobRunCountOn,
  lastJobRun,
  startJobRun,
  type JobTrigger,
} from "../db/repositories/systemHealth.js";
import { logger } from "../utils/logger.js";
import { runDbBackup } from "./backup.js";
import { runDailyControlCycle } from "./escalation.js";
import { runDueFollowups, type FollowupRunnerDeps, type FollowupRunResult } from "./followups.js";
import { buildWeeklyReport } from "./weeklyReport.js";

const BACKUP_HOUR = Number(process.env.BACKUP_HOUR ?? 6);
const DAILY_HOUR = Number(process.env.CONTROL_SCAN_HOUR ?? 7);
const WEEKLY_HOUR = Number(process.env.WEEKLY_REPORT_HOUR ?? 8);

const isWorkday = (weekday: number): boolean => weekday !== 5 && weekday !== 6; // 5=Fri 6=Sat
const isSunday = (weekday: number): boolean => weekday === 7;

interface Job {
  key: string;
  label: string;
  hour: number;
  runsOn: (weekday: number) => boolean;
  run: () => Promise<unknown>;
}

const JOBS: Job[] = [
  { key: "db_backup", label: "גיבוי DB", hour: BACKUP_HOUR, runsOn: () => true, run: async () => runDbBackup() },
  { key: "daily_cycle", label: "סבב יומי", hour: DAILY_HOUR, runsOn: isWorkday, run: runDailyControlCycle },
  { key: "weekly_report", label: "דוח שבועי", hour: WEEKLY_HOUR, runsOn: isSunday, run: buildWeeklyReport },
];

function msUntilNext(hour: number): number {
  const now = DateTime.now().setZone(env.TIMEZONE);
  let next = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (next <= now) next = next.plus({ days: 1 });
  return next.diff(now).toMillis();
}

/** מריץ עבודה עם רישום ב-job_runs. לא זורק — תקלה נרשמת ומתועדת, השרת ממשיך. */
async function runTracked(job: Job, trigger: JobTrigger): Promise<void> {
  const id = startJobRun(job.key, trigger);
  logger.info(`מתזמן [${job.label}]: מריץ (${trigger})`);
  try {
    await job.run();
    finishJobRun(id, true);
    logger.info(`מתזמן [${job.label}]: הסתיים בהצלחה`);
  } catch (err) {
    finishJobRun(id, false, (err as Error).message);
    logger.error(err, `מתזמן [${job.label}]: נכשל`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up Engine — קצב שונה מה-JOBS למעלה: כל כמה דקות, בתוך חלון עבודה, לא פעם ביום בשעה קבועה.
// ─────────────────────────────────────────────────────────────────────────────

/** ספים ותדירות — configurable כאן, לא hard-coded בלוגיקה. Buffer קטן לפני/אחרי שעות העבודה הרגילות. */
export const FOLLOWUP_SCHEDULE_CONFIG = {
  intervalMinutes: 15,
  workdayStart: { hour: 8, minute: 30 },
  workdayEnd: { hour: 17, minute: 30 },
} as const;

/**
 * האם "עכשיו" בתוך חלון העבודה של ה-Follow-up Engine — תמיד לפי env.TIMEZONE (Asia/Jerusalem),
 * לא לפי שעון השרת. פונקציה טהורה (רק DateTime פנימה/החוצה) — נבדקת ישירות בלי clock אמיתי.
 * גם מסננת ימי שישי/שבת (isWorkday, כמו daily_cycle) — אין טעם לפנות לעובדים כשאין מי שיענה.
 */
export function isWithinFollowupWindow(now: DateTime): boolean {
  const local = now.setZone(env.TIMEZONE);
  if (!isWorkday(local.weekday)) return false;
  const start = local.set({
    hour: FOLLOWUP_SCHEDULE_CONFIG.workdayStart.hour,
    minute: FOLLOWUP_SCHEDULE_CONFIG.workdayStart.minute,
    second: 0,
    millisecond: 0,
  });
  const end = local.set({
    hour: FOLLOWUP_SCHEDULE_CONFIG.workdayEnd.hour,
    minute: FOLLOWUP_SCHEDULE_CONFIG.workdayEnd.minute,
    second: 0,
    millisecond: 0,
  });
  return local >= start && local <= end;
}

/** מניעת overlap ברמת scheduler — ה-CAS ב-DB (claimFollowupForProcessing) נשאר שכבת הגנה נוספת. */
let followupRunInProgress = false;

/**
 * סבב אחד. עוטף runDueFollowups בהגנת overlap + לוג מסכם קצר (לא מציף אם אין due). now/deps
 * injectable — כך אפשר לבדוק בלי לחכות ל-interval אמיתי ובלי לגעת ב-Monday האמיתי.
 * כשל בלתי-צפוי בסבב עצמו (לא בפריט בודד — זה כבר מטופל בתוך runDueFollowups) נתפס כאן: לא מפיל
 * את ה-scheduler ולא את השרת, רק נרשם ומחכה לסבב הבא.
 */
export async function runFollowupCycle(
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
  deps: FollowupRunnerDeps = {},
): Promise<FollowupRunResult | null> {
  if (followupRunInProgress) {
    logger.info("Follow-up cycle: סבב קודם עדיין רץ — מדלג על הסבב הזה");
    return null;
  }
  followupRunInProgress = true;
  try {
    const result = await runDueFollowups(now, deps);
    if (result.checked > 0) {
      const triggered = result.processed.filter((p) => p.outcome === "nudge_sent").length;
      const completed = result.processed.filter((p) => p.outcome.startsWith("completed")).length;
      const skipped = result.processed.filter((p) => p.outcome === "skipped_parked").length;
      const failed = result.processed.filter((p) => p.outcome === "reverted_pending_error").length;
      logger.info(
        `Follow-up cycle: ${result.checked} due, ${triggered} triggered, ${completed} completed, ${skipped} skipped, ${failed} failed`,
      );
    }
    return result;
  } catch (err) {
    logger.error({ err }, "Follow-up cycle: כשל בלתי צפוי בסבב עצמו (לא בפריט בודד) — הסבב הבא ינסה שוב");
    return null;
  } finally {
    followupRunInProgress = false;
  }
}

/**
 * startup: אם עלינו בתוך חלון העבודה — מריצים catch-up מיידי (לא מחכים עד ל-tick הבא, שיכול
 * להיות עד intervalMinutes דקות משם). אם עלינו מחוץ לחלון (למשל בלילה) — לא פונים לעובדים;
 * ה-follow-ups שהגיע זמנם ימתינו לסבב הרגיל הראשון בתוך החלון (runDueFollowups לא "שוכח" אותם,
 * ראה dueAt<=now ב-followups.ts — אין כאן שום סינון שיחסום catch-up).
 */
export async function maybeRunFollowupCatchUpOnStartup(
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
  deps: FollowupRunnerDeps = {},
): Promise<boolean> {
  if (!isWithinFollowupWindow(now)) {
    logger.info("Follow-up Engine: עלה מחוץ לחלון העבודה — לא פונה לעובדים כרגע, ימתין לסבב הראשון בחלון");
    return false;
  }
  logger.info("Follow-up Engine: עלה בתוך חלון העבודה — מריץ catch-up מיידי");
  await runFollowupCycle(now, deps);
  return true;
}

let followupTimer: ReturnType<typeof setInterval> | null = null;

/** מפעיל את ה-interval הקבוע. Idempotent — קריאה חוזרת בזמן שכבר רץ לא יוצרת interval כפול. */
export function startFollowupSchedule(): void {
  if (followupTimer) return;
  const intervalMs = FOLLOWUP_SCHEDULE_CONFIG.intervalMinutes * 60_000;
  followupTimer = setInterval(() => {
    const now = DateTime.now().setZone(env.TIMEZONE);
    if (!isWithinFollowupWindow(now)) return; // מחוץ לחלון — לא רצים; שום דבר לא הולך לאיבוד, ר' catch-up למעלה
    void runFollowupCycle(now);
  }, intervalMs);
}

/** לא משאירים setInterval יתום — קרוי מ-tests, ומכל cleanup/shutdown עתידי של השרת. */
export function stopFollowupSchedule(): void {
  if (followupTimer) {
    clearInterval(followupTimer);
    followupTimer = null;
  }
}

let started = false;

function scheduleJob(job: Job): void {
  const tick = () => {
    const ms = msUntilNext(job.hour);
    logger.info(`מתזמן [${job.label}]: הבא בעוד ~${Math.round(ms / 60_000)} דקות`);
    setTimeout(async () => {
      const weekday = DateTime.now().setZone(env.TIMEZONE).weekday;
      if (job.runsOn(weekday)) await runTracked(job, "schedule");
      else logger.info(`מתזמן [${job.label}]: לא רלוונטי היום, מדלג`);
      tick();
    }, ms);
  };
  tick();
}

/** אחרי ריסטרט: עבודה שהיום שלה כבר הגיע (עברה השעה) ולא הותנעה אף פעם היום — מריצים עכשיו. */
function catchUp(): void {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const today = now.toISODate()!;
  for (const job of JOBS) {
    if (!job.runsOn(now.weekday)) continue;
    if (now.hour < job.hour) continue; // עוד לא הגיע הזמן — ה-schedule יתפוס
    if (jobRunCountOn(job.key, today) > 0) {
      // כבר הותנעה היום — אלא אם היא "תקועה": ריצה שלא הסתיימה מלפני יותר מ-30 דק'
      // (התהליך קרס באמצע ריצה קודמת). במקרה כזה כן מריצים שוב.
      const last = lastJobRun(job.key);
      const stuck =
        last?.ok === null &&
        !last.finishedAt &&
        now.diff(DateTime.fromSQL(last.startedAt, { zone: "utc" })).as("minutes") > 30;
      if (!stuck) continue;
      logger.warn(`מתזמן [${job.label}]: ריצה קודמת תקועה (${last?.startedAt}) — מריץ שוב`);
    } else {
      logger.info(`מתזמן [${job.label}]: לא רץ היום והשעה עברה — catch-up`);
    }
    void runTracked(job, "catchup");
  }
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  for (const job of JOBS) scheduleJob(job);
  catchUp();
  startFollowupSchedule();
  void maybeRunFollowupCatchUpOnStartup();
}
