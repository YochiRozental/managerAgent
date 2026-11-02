/**
 * סנכרון "זמן עבודה מצטבר" ל-Monday. SQLite (task_timer_segments) הוא מקור האמת; Monday הוא תצוגה.
 *
 * עקרונות:
 *  • נכתב **הסכום הכולל** (כל העובדים, כל הימים, מקטעים סגורים), מחושב מחדש מ-SQLite ברגע הכתיבה —
 *    לא תוספת. לכן ריצה חוזרת/ניסיון חוזר אידמפוטנטיים ולא יוצרים כפילות או חיסור.
 *  • סנכרון ישן/מקביל לא יכול לדרוס ערך חדש: (1) claim אטומי פר-פריט (CAS) — רק עובד אחד בכל רגע;
 *    (2) version עולה בכל סימון, והסיום מסמן synced רק אם version לא השתנה מאז ה-claim, אחרת הפריט חוזר
 *    ל-dirty ויכתב שוב עם הערך העדכני; (3) הערך תמיד מחושב אחרי ה-claim, לא לפניו.
 *  • כשל תקשורת: failed + backoff אקספוננציאלי (עד שעה) ועד MAX_ATTEMPTS; שגיאה קבועה (פריט נמחק, עמודה
 *    שגויה) → dead עד שינוי חדש בפריט. שום שעה לא הולכת לאיבוד כי המקור נשאר ב-SQLite.
 *  • חיסכון: אם הערך העשרוני ותצוגת HH:MM זהים לאחרונים שנכתבו — לא קוראים ל-Monday.
 *  • נכתבים שני ערכים באותה קריאה: שעות עשרוניות (עמודת מספר, לחישובים עתידיים) ו-HH:MM (עמודת טקסט, תצוגה).
 */

import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { listAllClosedItems } from "../db/repositories/taskTimers.js";
import {
  claimItem,
  completeSync,
  failSync,
  getSyncRow,
  listDueItemIds,
  markDirty,
  recoverStuckClaims,
} from "../db/repositories/taskTimerSync.js";
import { classifySyncError, type TaskTimerMondayClient } from "../integrations/monday/taskTimerMondayClient.js";
import { logger } from "../utils/logger.js";
import { computeItemTotalMs, formatHHMM, hoursFromMs } from "./taskTimerHours.js";

export const SYNC_BATCH_SIZE = 50;
export const SYNC_MAX_ATTEMPTS = 8;
export const SYNC_CLAIM_LEASE_MINUTES = 10;
const MAX_BACKOFF_MINUTES = 60;

export interface SyncRunResult {
  claimed: number;
  written: number;
  skippedUnchanged: number;
  failed: number;
  dead: number;
  requeued: number;
}

export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MINUTES);
}

/** מסמן את כל הפריטים שיש להם מקטעים סגורים (הפעלה ראשונה / אחרי תקופה שהדגל היה כבוי). זול: ההשוואה מקומית. */
export function backfillTaskTimerSync(): number {
  let n = 0;
  for (const it of listAllClosedItems()) {
    markDirty(it.itemId, it.itemSource);
    n++;
  }
  return n;
}

export async function runTaskTimerMondaySync(
  client: TaskTimerMondayClient,
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
): Promise<SyncRunResult> {
  const result: SyncRunResult = { claimed: 0, written: 0, skippedUnchanged: 0, failed: 0, dead: 0, requeued: 0 };
  const nowIso = now.toUTC().toISO()!;
  result.requeued = recoverStuckClaims(now.minus({ minutes: SYNC_CLAIM_LEASE_MINUTES }).toUTC().toISO()!);

  for (const itemId of listDueItemIds(nowIso, SYNC_BATCH_SIZE)) {
    const claimId = randomUUID();
    if (!claimItem(itemId, claimId, nowIso)) continue; // מישהו אחר תפס / כבר לא due
    result.claimed++;
    const row = getSyncRow(itemId)!;
    try {
      // הערך מחושב *אחרי* ה-claim: כל שינוי שנרשם עד עכשיו כלול; שינוי שיגיע בזמן הכתיבה יעלה version.
      const ms = computeItemTotalMs(itemId, nowIso);
      const hours = hoursFromMs(ms);
      const display = formatHHMM(ms);
      // דילוג רק כשגם הערך העשרוני וגם תצוגת HH:MM זהים לאחרונים שנכתבו. last_display ריק (שורות מלפני
      // הוספת התצוגה) ≠ display → נכתב מחדש גם אם משך הזמן לא השתנה.
      if (row.lastValue !== null && row.lastValue === hours && row.lastDisplay === display && row.lastSyncedAt) {
        result.skippedUnchanged++;
      } else {
        await client.writeCumulative(row.itemSource, itemId, { hours, display });
        result.written++;
      }
      completeSync(itemId, claimId, hours, ms, display, nowIso);
    } catch (err) {
      const { permanent, message } = classifySyncError(err);
      const attempts = row.attempts + 1;
      if (permanent || attempts >= SYNC_MAX_ATTEMPTS) {
        failSync(itemId, claimId, "dead", message, null);
        result.dead++;
        logger.error({ itemId, attempts, message }, "סנכרון זמן עבודה ל-Monday נכשל לצמיתות — הפריט מסומן dead עד שינוי חדש");
      } else {
        failSync(itemId, claimId, "failed", message, now.plus({ minutes: backoffMinutes(attempts) }).toUTC().toISO()!);
        result.failed++;
        logger.warn({ itemId, attempts, message }, "סנכרון זמן עבודה ל-Monday נכשל — ינוסה שוב");
      }
    }
  }
  return result;
}
