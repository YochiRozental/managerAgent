/**
 * מתזמן את הסבבים היזומים של מנוע הבקרה — רץ בתוך שרת החלונית (התהליך שתמיד למעלה תחת PM2).
 *   • סבב יומי  — CONTROL_SCAN_HOUR (ברירת מחדל 7:00), א׳–ה׳
 *   • דוח שבועי — WEEKLY_REPORT_HOUR (ברירת מחדל 8:00), יום א׳
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { runDailyControlCycle } from "./escalation.js";
import { buildWeeklyReport } from "./weeklyReport.js";

const DAILY_HOUR = Number(process.env.CONTROL_SCAN_HOUR ?? 7);
const WEEKLY_HOUR = Number(process.env.WEEKLY_REPORT_HOUR ?? 8);

function msUntilNext(hour: number): number {
  const now = DateTime.now().setZone(env.TIMEZONE);
  let next = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (next <= now) next = next.plus({ days: 1 });
  return next.diff(now).toMillis();
}

let started = false;

function scheduleLoop(hour: number, label: string, shouldRun: (day: number) => boolean, run: () => Promise<unknown>) {
  const tick = () => {
    const ms = msUntilNext(hour);
    logger.info(`מתזמן [${label}]: הבא בעוד ~${Math.round(ms / 60_000)} דקות`);
    setTimeout(async () => {
      const day = DateTime.now().setZone(env.TIMEZONE).weekday; // 1=Mon … 7=Sun
      try {
        if (shouldRun(day)) await run();
        else logger.info(`מתזמן [${label}]: לא רלוונטי היום, מדלג`);
      } catch (err) {
        logger.error(err, `מתזמן [${label}]: נכשל`);
      }
      tick();
    }, ms);
  };
  tick();
}

export function startScheduler(): void {
  if (started) return;
  started = true;

  // סבב יומי — כל יום עבודה (א׳–ה׳ = weekday 7,1,2,3,4)
  scheduleLoop(DAILY_HOUR, "סבב יומי", (d) => d !== 5 && d !== 6, runDailyControlCycle);

  // דוח שבועי — יום א׳ בלבד (weekday 7)
  scheduleLoop(WEEKLY_HOUR, "דוח שבועי", (d) => d === 7, buildWeeklyReport);
}
