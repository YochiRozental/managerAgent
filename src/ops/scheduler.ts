/**
 * מתזמן את הסבבים היזומים של מנוע הבקרה — רץ בתוך שרת החלונית (התהליך שתמיד למעלה תחת PM2/Docker).
 *   • גיבוי DB  — BACKUP_HOUR (ברירת מחדל 6:00), כל יום
 *   • סבב יומי  — CONTROL_SCAN_HOUR (ברירת מחדל 7:00), א׳–ה׳
 *   • דוח שבועי — WEEKLY_REPORT_HOUR (ברירת מחדל 8:00), יום א׳
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
}
