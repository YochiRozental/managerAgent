/**
 * מתזמן את הסבב היומי של מנוע הבקרה. רץ בתוך שרת החלונית (התהליך שנמצא תמיד למעלה תחת PM2).
 * שעה: CONTROL_SCAN_HOUR (ברירת מחדל 7). א׳–ה׳ בלבד.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { runDailyControlCycle } from "./escalation.js";

const SCAN_HOUR = Number(process.env.CONTROL_SCAN_HOUR ?? 7);

function msUntilNext(hour: number): number {
  const now = DateTime.now().setZone(env.TIMEZONE);
  let next = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (next <= now) next = next.plus({ days: 1 });
  return next.diff(now).toMillis();
}

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  const schedule = () => {
    const ms = msUntilNext(SCAN_HOUR);
    logger.info(`מנוע הבקרה: הסבב הבא בעוד ~${Math.round(ms / 60_000)} דקות (${SCAN_HOUR}:00)`);
    setTimeout(async () => {
      try {
        const day = DateTime.now().setZone(env.TIMEZONE).weekday; // 5=Fri 6=Sat
        if (day !== 5 && day !== 6) await runDailyControlCycle();
        else logger.info("מנוע הבקרה: סופ״ש — מדלג");
      } catch (err) {
        logger.error(err, "מנוע הבקרה: הסבב היומי נכשל");
      }
      schedule();
    }, ms);
  };

  schedule();
}
