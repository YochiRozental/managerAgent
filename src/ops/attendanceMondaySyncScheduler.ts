/**
 * Ticker סנכרון נוכחות ← Monday (שלב ה, הכנת פיילוט — 2026-10-12).
 *
 * כבוי לגמרי כש-ATTENDANCE_MODULE_ENABLED=false — startAttendanceMondaySyncSchedule() בודק את
 * עצמו (הגנה כפולה, בדיוק עיקרון startAttendanceReminderSchedule): לא נוצר client אמיתי, לא
 * מופעל טיימר, אפס קריאה ל-Monday. גם כשהדגל מופעל — runAttendanceMondaySync מסנן לפי
 * attendancePilotUserKeys (ATTENDANCE_PILOT_USER_KEYS מה-env): רק עובדים שהוגדרו במפורש לפיילוט.
 *
 * תיעוד שגיאות + retry (לפי הדרישה):
 *   • per-run — כל טיק נרשם ב-job_runs (job="attendance_monday_sync") עם ok/error — בדיוק כמו
 *     שאר העבודות המתוזמנות (scheduler.ts), נראה ב-/health ובהיסטוריית ריצות.
 *   • per-day — יום בודד שנכשל מסומן monday_sync_status='failed' (ר' attendanceMondaySync.ts);
 *     listDaysNeedingMondaySync כולל גם 'failed' — הטיק הבא מנסה שוב אוטומטית, בלי התערבות ידנית.
 *
 * מניעת כפילות אחרי קריסה/ריסטרט: recoverStuckAttendanceMondaySyncs() ב-startup מאפס שורות
 * שנשארו תקועות ב-'pending' (קריסה תוך-כדי ריצת job קודמת) ל-'not_synced' — הטיק הבא מסנכרן
 * אותן מההתחלה, בלי ליצור כפילות (ר' idempotency הכפולה ב-syncAttendanceDayToMonday עצמה:
 * ref מקומי → חיפוש ב-Monday לפי syncId → רק אז יצירה).
 */

import { env } from "../config/env.js";
import { isAttendanceModuleEnabled } from "./attendance.js";
import { runAttendanceMondaySync, recoverStuckAttendanceMondaySyncs } from "./attendanceMondaySync.js";
import { createRealMondayAttendanceClient } from "../integrations/monday/attendanceMondayClient.js";
import { startJobRun, finishJobRun } from "../db/repositories/systemHealth.js";
import { logger } from "../utils/logger.js";

const JOB_KEY = "attendance_monday_sync";
const TICK_MS = 5 * 60_000; // 5 דק' — מספק עדכניות סבירה בלי להעמיס על Monday API

let tickInProgress = false;

/** סבב אחד. injectable client בשביל בדיקות — ברירת מחדל = הלקוח האמיתי. */
export async function runAttendanceMondaySyncTick(
  client = createRealMondayAttendanceClient(),
): Promise<void> {
  if (tickInProgress) return; // הגנת overlap ברמת ה-scheduler — ה-CAS ב-DB (claimMondaySync) נשאר שכבת הגנה נוספת
  tickInProgress = true;
  const runId = startJobRun(JOB_KEY, "schedule");
  try {
    const result = await runAttendanceMondaySync(client);
    finishJobRun(runId, true);
    if (result.checked > 0) {
      logger.info(
        { ...result },
        `סנכרון נוכחות ל-Monday: ${result.checked} ימים נבדקו, ${result.synced} סונכרנו, ${result.failed} נכשלו`,
      );
    }
  } catch (err) {
    finishJobRun(runId, false, (err as Error).message);
    logger.error({ err }, "סנכרון נוכחות ל-Monday: כשל בלתי-צפוי בסבב עצמו (לא ביום בודד — זה מטופל בתוך runAttendanceMondaySync) — הטיק הבא ינסה שוב");
  } finally {
    tickInProgress = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * מפעיל את ה-ticker. בודק ATTENDANCE_MODULE_ENABLED בעצמו — חיווט מ-scheduler.ts בטוח גם לפני
 * הפעלה בפועל. Idempotent — קריאה חוזרת בזמן שכבר רץ לא יוצרת interval כפול.
 */
export function startAttendanceMondaySyncSchedule(): void {
  if (timer) return;
  if (!isAttendanceModuleEnabled()) {
    logger.info("מודול נוכחות כבוי (ATTENDANCE_MODULE_ENABLED=false) — ticker סנכרון Monday לא מופעל.");
    return;
  }
  const recovered = recoverStuckAttendanceMondaySyncs();
  if (recovered > 0) logger.warn({ recovered }, "סנכרון נוכחות ל-Monday: שוחזרו שורות תקועות (קריסה/ריסטרט קודם)");
  timer = setInterval(() => void runAttendanceMondaySyncTick(), TICK_MS);
  logger.info({ pilotUsers: env.ATTENDANCE_PILOT_USER_KEYS }, "סנכרון נוכחות ל-Monday: ticker הופעל");
}

export function stopAttendanceMondaySyncSchedule(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
