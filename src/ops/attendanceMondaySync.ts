/**
 * מודול נוכחות — אורקסטרציית סנכרון ל-Monday (שלב ד, הכנה בלבד).
 *
 * החלטה 4 (אושרה): הסנכרון מבוסס על ה-DB המשותף בלבד — קורא מ-attendance_days, **לא** תלוי
 * בערוץ שבו הדיווח בוצע (חלונית/WhatsApp). לכן זה job נפרד שסורק ימים הזקוקים לסנכרון, לא קריאה
 * inline מתוך chat.ts/messageHandler.ts.
 *
 * **לא קרוי משום מקום בקוד הפעיל** (לא ב-scheduler.ts, לא מופעל אוטומטית) — ר' גבולות האישור.
 * נבדק רק מול FakeMondayAttendanceClient בזיכרון (scripts/test-attendance-monday-sync.ts).
 *
 * אידמפוטנטיות בשתי שכבות (לפי הדרישה — "לפני יצירת פריט חדש בדוק אם כבר קיים"):
 *   1. מקומית: attendance_days.monday_sync_ref — אם קיים, מעדכנים אותו פריט (לא יוצרים).
 *   2. ב-Monday עצמו: אם אין ref מקומי (למשל קרס אחרי create_item לפני ששמרנו אותו), מחפשים
 *      לפי מזהה הסנכרון (buildAttendanceSyncId) *לפני* יצירה — אם נמצא, מאמצים אותו (לא כפילות).
 */

import { DateTime } from "luxon";
import { env, attendancePilotUserKeys } from "../config/env.js";
import {
  listDaysNeedingMondaySync,
  claimMondaySync,
  markMondaySynced,
  markMondaySyncFailed,
  recoverStuckMondaySyncs,
  type StoredAttendanceDay,
} from "../db/repositories/attendanceDays.js";
import { getAttendanceBoardId, buildAttendanceSyncId } from "../integrations/monday/attendanceBoards.js";
import {
  buildAttendanceItemName,
  type MondayAttendanceClient,
  type MondayAttendanceColumnValues,
} from "../integrations/monday/attendanceMondayClient.js";
import { logger } from "../utils/logger.js";

/**
 * תוקן (audit שלב ו, 2026-10-12, read-only-review): היה חסר .setZone(env.TIMEZONE) — DateTime.fromISO
 * על מחרוזת UTC ("...Z") מציג hour/minute לפי אזור הזמן של ה-process (תלוי-מכונה!), לא לפי
 * Asia/Jerusalem במפורש. בלי התיקון, "כניסה ראשונה"/"יציאה אחרונה" היו יוצאים שגויים בכל שרת
 * שלא מוגדר ל-Asia/Jerusalem כברירת המחדל שלו (למשל קונטיינר Docker שברירת המחדל שלו UTC).
 */
function toLocalHourMinute(utcIso: string | null): { hour: number; minute: number } | null {
  if (!utcIso) return null;
  const dt = DateTime.fromISO(utcIso, { zone: "utc" }).setZone(env.TIMEZONE);
  return { hour: dt.hour, minute: dt.minute };
}

/** "פתוח"/"סגור" כבר לא רלוונטי — syncים רק ימים closed (ר' listDaysNeedingMondaySync) — אבל
 *  המקור יכול עדיין להיות מתוקן אחרי הסנכרון הראשון; סטטוס הדיווח משקף את זה. */
function statusLabelFor(day: StoredAttendanceDay): string {
  return "סגור";
}

function sourceLabelFor(): string {
  // כרגע כל התיקונים/דיווחים חיים עוברים דרך ops/attendance.ts בלי תיעוד source מצטבר ברמת היום
  // (רק ברמת אירוע בודד) — ברירת מחדל סבירה; שיפור עתידי: לגזור מה-source של האירוע האחרון.
  return "סוכן";
}

function buildColumnValues(userKey: string, day: StoredAttendanceDay): MondayAttendanceColumnValues {
  return {
    workDate: day.workDate,
    firstInLocal: toLocalHourMinute(day.openedReportedAt),
    lastOutLocal: toLocalHourMinute(day.closedReportedAt),
    breakMinutes: day.breakMinutes,
    netHours: day.netMinutes != null ? Math.round((day.netMinutes / 60) * 100) / 100 : 0,
    statusLabel: statusLabelFor(day),
    segmentCount: day.segmentCount,
    sourceLabel: sourceLabelFor(),
    syncId: buildAttendanceSyncId(userKey, day.workDate),
  };
}

export interface SyncOneDayResult {
  action: "created" | "updated" | "adopted_existing" | "no_board_configured";
  itemId?: string;
}

/**
 * מסנכרנת יום בודד. **לא** תופסת/מסיימת claim בעצמה — זה תפקיד הקורא (runAttendanceMondaySync),
 * כדי שהפונקציה הזו תהיה קלה לבדיקה ישירה בלי להתעסק ב-CAS.
 *
 * itemNameOverride (audit שלב ו, 2026-10-12): אופציונלי, ברירת מחדל = buildAttendanceItemName
 * (שם לפי תאריך, ללא שינוי בהתנהגות הקיימת). נוסף כדי שבדיקת-סנכרון מבוקרת (שם פריט קבוע לבדיקה,
 * לא תאריך) תעבור *דרך המנגנון האמיתי* (create_item/find/update הרגילים) ולא תצטרך כתיבה ידנית
 * חוצת-מנגנון ל-Monday כדי לשנות שם אחרי יצירה.
 */
export async function syncAttendanceDayToMonday(
  userKey: string,
  day: StoredAttendanceDay,
  client: MondayAttendanceClient,
  itemNameOverride?: string,
): Promise<SyncOneDayResult> {
  const boardId = getAttendanceBoardId(userKey);
  if (!boardId) return { action: "no_board_configured" };

  const values = buildColumnValues(userKey, day);

  // 1. יש ref מקומי — מעדכנים את אותו פריט (לא יוצרים נוסף). זה גם מסלול התיקון: "בתיקון שעות,
  //    עדכן את אותו פריט ולא תיצור פריט נוסף".
  if (day.mondaySyncRef) {
    await client.updateItem(boardId, day.mondaySyncRef, values);
    return { action: "updated", itemId: day.mondaySyncRef };
  }

  // 2. אין ref מקומי — בודקים ב-Monday עצמו *לפני* יצירה (מגן על קריסה בין create_item מוצלח
  //    ל-markMondaySynced המקומי, שהייתה יוצרת כפילות בניסיון הבא בלי הבדיקה הזו).
  const existing = await client.findItemBySyncId(boardId, values.syncId);
  if (existing) {
    await client.updateItem(boardId, existing.itemId, values); // מרענן ערכים, ליתר ביטחון
    return { action: "adopted_existing", itemId: existing.itemId };
  }

  // 3. אין בשום מקום — יוצרים.
  const created = await client.createItem(boardId, itemNameOverride ?? buildAttendanceItemName(day.workDate), values);
  return { action: "created", itemId: created.itemId };
}

export interface MondaySyncRunResult {
  checked: number;
  synced: number;
  failed: number;
  noBoardConfigured: number;
}

/**
 * ה-job: סורק ימים הזקוקים לסנכרון, עם claim/retry.
 *
 * pilotUserKeys (שלב ה, 2026-10-12): ברירת מחדל = attendancePilotUserKeys (ATTENDANCE_PILOT_USER_KEYS
 * מה-env) — הסנכרון רץ *רק* על עובדים שהוגדרו במפורש לפיילוט, גם אם מסיבה כלשהי יש ב-attendance_days
 * ימים של משתמש אחר (הגנת-עומק: ההגנה הראשית היא ש-attendanceEnabledForUser חוסם דיווח מלכתחילה
 * למי שלא בפיילוט — זה שכבה שנייה, לא היחידה). injectable כדי שבדיקות ימוחזרות יוכלו להעביר allowlist
 * מפורש בלי להיות תלויות ב-.env האמיתי של התהליך.
 */
export async function runAttendanceMondaySync(
  client: MondayAttendanceClient,
  pilotUserKeys: string[] = attendancePilotUserKeys,
): Promise<MondaySyncRunResult> {
  const days = listDaysNeedingMondaySync().filter((d) => pilotUserKeys.includes(d.userKey));
  let synced = 0;
  let failed = 0;
  let noBoardConfigured = 0;

  for (const day of days) {
    if (!claimMondaySync(day.userKey, day.workDate)) continue; // job אחר כבר תפס, או שהוא לא במצב תקין לתפיסה

    try {
      const result = await syncAttendanceDayToMonday(day.userKey, day, client);
      if (result.action === "no_board_configured") {
        logger.warn({ user: day.userKey, workDate: day.workDate }, "סנכרון נוכחות: אין לוח Monday מוגדר למשתמש זה — מדלג");
        markMondaySyncFailed(day.userKey, day.workDate);
        noBoardConfigured++;
        continue;
      }
      const claimed = markMondaySynced(day.userKey, day.workDate, result.itemId!);
      if (!claimed) {
        // תיקון הגיע תוך-כדי הסנכרון (recomputeAndPersistDay כבר אופס ל-not_synced) — לא "אבד",
        // ה-resync הבא יתפוס את הערכים העדכניים. לא כשל, לא מונה כ-failed.
        logger.info({ user: day.userKey, workDate: day.workDate }, "סנכרון נוכחות: היום תוקן תוך-כדי הסנכרון — יסונכרן שוב בריצה הבאה");
      }
      synced++;
    } catch (err) {
      logger.error({ err, user: day.userKey, workDate: day.workDate }, "סנכרון נוכחות: נכשל — יינסה שוב בריצה הבאה");
      markMondaySyncFailed(day.userKey, day.workDate);
      failed++;
    }
  }

  return { checked: days.length, synced, failed, noBoardConfigured };
}

/** startup בלבד — משחזר 'pending' תקוע (קריסה תוך-כדי ריצת job קודמת) ל-'not_synced'. */
export function recoverStuckAttendanceMondaySyncs(): number {
  return recoverStuckMondaySyncs();
}
