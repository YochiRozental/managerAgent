/**
 * בדיקת מוכנות לפיילוט — מודול נוכחות (שלב ה, 2026-10-12).
 *
 * שרשרת אחת, קוהרנטית, ע"פ הדרישה המדויקת:
 *   כניסה ראשונה → פתיחת יום → הפסקה → חזרה → סגירת יום → סנכרון → תיקון שעות → עדכון Monday.
 * כל השרשרת רצה מול FakeMondayAttendanceClient בזיכרון — **אפס קריאה ל-Monday אמיתי**, אפס
 * דיווח נוכחות אמיתי (עובד/תאריך/חודש בדיקה מיוחדים, ר' למטה) — תואם לגבולות האישור של שלב זה.
 *
 * שאר התרחישים שהוזמנו לבדיקת-המוכנות (משתמש לא מורשה, שתי הודעות במקביל, כשל רשת, הפעלה מחדש
 * של השרת, חודש שכר סגור, תזכורת אישית, חוסר דיווח בסוף יום) **כבר מכוסים** ע"י בדיקות קיימות,
 * שהורחבו/חוזקו במסגרת בדיקת-המוכנות הזו — ר' הסיכום בסוף הקובץ לפירוט מדויק: קובץ+שורה.
 * לא כופלים אותם כאן כדי לא ליצור שני מקורות-אמת לאותה התנהגות.
 *
 *   npm run test:attendance-pilot-readiness
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { logger } from "../src/utils/logger.js";
import { resolveUserByKey } from "../src/identity/index.js";
import {
  checkAttendanceDayStart,
  reportBreakStart,
  reportBreakEnd,
  reportDayClose,
  requestAttendanceCorrection,
} from "../src/ops/attendance.js";
import { getDay } from "../src/db/repositories/attendanceDays.js";
import { listEventsForDay } from "../src/db/repositories/attendanceEvents.js";
import { buildMessageIdempotencySeed } from "../src/ops/attendanceEngine.js";
import { buildAttendanceSyncId } from "../src/integrations/monday/attendanceBoards.js";
import type { MondayAttendanceClient, MondayAttendanceColumnValues } from "../src/integrations/monday/attendanceMondayClient.js";
import { runAttendanceMondaySync } from "../src/ops/attendanceMondaySync.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const yochi = resolveUserByKey("yochi")!;
const TEST_USERS = ["yochi"];
const TEST_MONTH = "2031-03"; // עתידי מכוון — אפס סיכוי התנגשות עם payroll_month_locks אמיתי
const DAY = `${TEST_MONTH}-10`;

function cleanup(): void {
  const placeholders = TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_corrections WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
}
cleanup();

const at = (hhmm: string) => DateTime.fromISO(`${DAY}T${hhmm}:00`, { zone: env.TIMEZONE });
let turnCounter = 0;
const seed = () => buildMessageIdempotencySeed({ scopeId: "pilot-readiness", turnOrdinal: turnCounter++ });

// ── Monday API מדומה בזיכרון — זהה בעקרון ל-test-attendance-monday-sync.ts ──────────────────────
interface FakeItem {
  itemId: string;
  boardId: string;
  name: string;
  values: MondayAttendanceColumnValues;
}
class FakeMondayAttendanceClient implements MondayAttendanceClient {
  items: FakeItem[] = [];
  private nextId = 1;
  async findItemBySyncId(boardId: string, syncId: string) {
    const item = this.items.find((i) => i.boardId === boardId && i.values.syncId === syncId);
    return item ? { itemId: item.itemId } : null;
  }
  async createItem(boardId: string, itemName: string, values: MondayAttendanceColumnValues) {
    const itemId = String(this.nextId++);
    this.items.push({ itemId, boardId, name: itemName, values });
    return { itemId };
  }
  async updateItem(boardId: string, itemId: string, values: MondayAttendanceColumnValues) {
    const item = this.items.find((i) => i.boardId === boardId && i.itemId === itemId);
    if (!item) throw new Error(`פריט ${itemId} לא נמצא (מדומה)`);
    item.values = values;
  }
}

async function run() {
  const client = new FakeMondayAttendanceClient();

  // ── 1. כניסה ראשונה → פתיחת יום (אוטומטי, Day-Start Gate) ──────────────────────────────────
  const startResult = checkAttendanceDayStart(yochi, at("09:00"));
  check("1a. כניסה ראשונה: בנר פתיחה הוחזר", !!startResult.banner);
  check("1b. יום נפתח, status=open (attendance_days.status גס — open/closed בלבד)", getDay(yochi.key, DAY)?.status === "open");
  const dayOpenEvents = listEventsForDay(yochi.key, DAY).filter((e) => e.eventType === "day_open");
  check("1c. אירוע day_open יחיד נכתב", dayOpenEvents.length === 1, String(dayOpenEvents.length));

  // ── 2. הפסקה ──────────────────────────────────────────────────────────────────────────────
  const breakStartResult = reportBreakStart(yochi, at("12:00"), seed());
  check("2a. דיווח הפסקה הצליח", breakStartResult.ok, breakStartResult.message);

  // ── 3. חזרה ───────────────────────────────────────────────────────────────────────────────
  const breakEndResult = reportBreakEnd(yochi, at("12:30"), seed());
  check("3a. דיווח חזרה הצליח", breakEndResult.ok, breakEndResult.message);

  // ── 4. סגירת יום ──────────────────────────────────────────────────────────────────────────
  const closeResult = reportDayClose(yochi, at("17:00"), seed());
  check("4a. דיווח סגירה הצליח", closeResult.ok, closeResult.message);
  const dayAfterClose = getDay(yochi.key, DAY)!;
  check("4b. היום נסגר (status=closed)", dayAfterClose.status === "closed");
  check("4c. שעות נטו = 450 דק' (09:00-17:00 פחות 30 דק' הפסקה)", dayAfterClose.netMinutes === 450, String(dayAfterClose.netMinutes));
  check("4d. monday_sync_status=not_synced (ממתין לסנכרון הראשון)", dayAfterClose.mondaySyncStatus === "not_synced");

  // ── 5. סנכרון ל-Monday (ראשון) — דרך runAttendanceMondaySync (עטיפת ה-job, לא syncAttendanceDayToMonday
  //    הבודדת) כדי שה-ref יישמר בפועל ב-DB (markMondaySynced), בדיוק כמו שהריצה האמיתית תעבוד ──────
  const firstSyncRun = await runAttendanceMondaySync(client, TEST_USERS);
  check("5a. סנכרון ראשון: synced>=1", firstSyncRun.synced >= 1, JSON.stringify(firstSyncRun));
  const itemId = getDay(yochi.key, DAY)?.mondaySyncRef;
  check("5b. יש itemId אחרי היצירה, נשמר ב-DB", !!itemId, String(itemId));
  check("5c. הערך שנכתב ל-Monday: שעות נטו=7.5", client.items[0]?.values.netHours === 7.5, String(client.items[0]?.values.netHours));

  // ── 6. תיקון שעות (העובד: "בעצם סיימתי ב-17:30, לא ב-17:00") ─────────────────────────────
  const closeEvent = listEventsForDay(yochi.key, DAY).find((e) => e.eventType === "day_close")!;
  const correctionResult = requestAttendanceCorrection(yochi, {
    workDate: DAY,
    field: "day_close",
    newReportedForAtUtcIso: at("17:30").toUTC().toISO()!,
    reason: "בדיקת-מוכנות-לפיילוט — תיקון שעות",
    messageSeed: seed(),
  });
  check("6a. בקשת התיקון התקבלה", correctionResult.ok, correctionResult.message);
  check("6b. התיקון הוחל אוטומטית (אין payroll_month_lock על חודש הבדיקה)", correctionResult.correction?.status === "applied", correctionResult.correction?.status);
  const dayAfterCorrection = getDay(yochi.key, DAY)!;
  check("6c. שעות נטו עודכנו ל-480 דק' (09:00-17:30 פחות 30 דק')", dayAfterCorrection.netMinutes === 480, String(dayAfterCorrection.netMinutes));
  check("6d. monday_sync_status אופס ל-not_synced (התיקון דרש ריסנכרון)", dayAfterCorrection.mondaySyncStatus === "not_synced");
  check("6e. ref מקומי ל-Monday עדיין קיים (לא אבד בתיקון)", dayAfterCorrection.mondaySyncRef === itemId);
  void closeEvent;

  // ── 7. עדכון Monday (סנכרון שני — אחרי התיקון) ───────────────────────────────────────────
  const resyncRun = await runAttendanceMondaySync(client, TEST_USERS);
  check("7a. הריצה השנייה סינכרנה לפחות יום אחד", resyncRun.synced >= 1, JSON.stringify(resyncRun));
  const dayAfterResync = getDay(yochi.key, DAY)!;
  check("7b. monday_sync_status=synced אחרי הריסנכרון", dayAfterResync.mondaySyncStatus === "synced");
  check("7c. *אותו* itemId — לא נוצר פריט נוסף", dayAfterResync.mondaySyncRef === itemId);
  check("7d. פריט בודד בלבד ב-Monday המדומה (אין כפילות)", client.items.length === 1, String(client.items.length));
  check("7e. הערך הסופי שנכתב ל-Monday משקף את התיקון: שעות נטו=8.0", client.items[0]?.values.netHours === 8.0, String(client.items[0]?.values.netHours));
  check(
    "7f. מזהה הסנכרון נשאר קבוע (לא השתנה בין היצירה לעדכון)",
    client.items[0]?.values.syncId === buildAttendanceSyncId(yochi.key, DAY),
  );

  cleanup();

  // ── סיכום כיסוי תרחישי הבדיקה המבוקשים ────────────────────────────────────────────────────
  logger.info(
    "\n" +
      "── כיסוי תרחישי בדיקת-המוכנות (לא כפול כאן — ר' הקובץ+השורה) ──\n" +
      "  • השרשרת המלאה (כניסה→פתיחה→הפסקה→חזרה→סגירה→סנכרון→תיקון→עדכון): קובץ זה, סעיפים 1–7.\n" +
      "  • משתמש לא מורשה (לא-פיילוט, בעל report:hours): test-attendance-tools.ts, סעיף 'הגנת-עומק'.\n" +
      "  • שתי הודעות במקביל (clientMessageId, שתי לשוניות): test-attendance-concurrency.ts, סעיפים 1-3; test-chat-dedup.ts, סעיפים 3-5.\n" +
      "  • כשל רשת (Monday create נכשל→retry): test-attendance-monday-sync.ts, סעיף 6.\n" +
      "  • הפעלה מחדש של השרת (claim תקוע→recovery): test-attendance-monday-sync.ts סעיף 7 (סנכרון) ;" +
      " test-attendance.ts (תזכורות, בתוך/מחוץ לטרנזקציה) ; test-chat-dedup.ts סעיף 7 (דיאלוג).\n" +
      "  • חודש שכר סגור (תיקון ממתין לאישור מנהל): test-attendance-monday-sync.ts סעיף 8 ; test-attendance.ts סעיף 18f.\n" +
      "  • תזכורת אישית (שליחה, שינוי שעה, אין כפילות): test-attendance.ts סעיפים 10-11.\n" +
      "  • חוסר דיווח בסוף יום (pending_completion + השלמה למחרת): test-attendance.ts סעיפים 13c, 'אתמול סיימתי בארבע'.\n" +
      "  • allowlist פיילוט ברמת ה-job (עובד לא-פיילוט לא מסונכרן): test-attendance-monday-sync.ts סעיף 9.",
  );
}

run()
  .then(() => {
    if (failed > 0) {
      logger.error(`${failed} בדיקות נכשלו`);
      process.exit(1);
    }
    logger.info("\nכל הבדיקות עברו ✅ — השרשרת המלאה עובדת מקצה לקצה (מול Monday מדומה)");
  })
  .catch((err) => {
    logger.error({ err }, "בדיקה קרסה");
    process.exit(1);
  });
