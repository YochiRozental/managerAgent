/**
 * מודול נוכחות — סנכרון Monday (שלב ד). נבדק **רק** מול Monday API מדומה (FakeMondayAttendanceClient
 * בזיכרון) — אין קריאה אחת ל-Monday אמיתי בקובץ הזה, בדיוק כנדרש. בודק: idempotency (מקומי +
 * ב-"Monday" עצמו), עדכון-לא-יצירה-שנייה בתיקון, retry/כשל, והתאוששות מ-pending תקוע.
 *
 *   הועבר אחד-לאחד מ-scripts/test-attendance-monday-sync.ts (הוסר). רץ ב-npm test, על DB זמני מבודד בלבד (tests/setup).
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/db.js";
import { logger } from "../../src/utils/logger.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { checkAttendanceDayStart, reportDayClose, requestAttendanceCorrection } from "../../src/ops/attendance.js";
import { getDay } from "../../src/db/repositories/attendanceDays.js";
import { listEventsForDay } from "../../src/db/repositories/attendanceEvents.js";
import { closePayrollMonth, reopenPayrollMonth } from "../../src/db/repositories/payrollMonths.js";
import { buildMessageIdempotencySeed } from "../../src/ops/attendanceEngine.js";
import { buildAttendanceSyncId, getAttendanceBoardId } from "../../src/integrations/monday/attendanceBoards.js";
import type { MondayAttendanceClient, MondayAttendanceColumnValues } from "../../src/integrations/monday/attendanceMondayClient.js";
import { syncAttendanceDayToMonday, runAttendanceMondaySync, recoverStuckAttendanceMondaySyncs } from "../../src/ops/attendanceMondaySync.js";
import { check } from "../helpers/check.js";


const yochi = resolveUserByKey("yochi")!;
const dov = resolveUserByKey("dov")!; // משתמש "לא-פיילוט" — רק לבדיקת סעיף 9 (allowlist), אף פעם לא ב-TEST_USERS/pilotUserKeys
const TEST_USERS = ["yochi"];
const ALL_TEST_USERS = ["yochi", "dov"]; // לניקוי בלבד
const TEST_MONTH = "2030-06";

function cleanup(): void {
  const placeholders = ALL_TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders})`).run(...ALL_TEST_USERS);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders})`).run(...ALL_TEST_USERS);
  db.prepare(`DELETE FROM attendance_corrections WHERE user_key IN (${placeholders})`).run(...ALL_TEST_USERS);
  db.prepare(`DELETE FROM payroll_month_locks WHERE month = ?`).run(TEST_MONTH);
}
cleanup();

const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });
let turnCounter = 0;
const seed = () => buildMessageIdempotencySeed({ scopeId: "sync-test", turnOrdinal: turnCounter++ });

// ── Monday API מדומה בזיכרון — אפס קריאה לרשת/API אמיתי ──────────────────────────────────────
interface FakeItem {
  itemId: string;
  boardId: string;
  name: string;
  values: MondayAttendanceColumnValues;
}

class FakeMondayAttendanceClient implements MondayAttendanceClient {
  items: FakeItem[] = [];
  calls = { find: 0, create: 0, update: 0 };
  private nextId = 1;
  failNextCreate = false;

  async findItemBySyncId(boardId: string, syncId: string) {
    this.calls.find++;
    const item = this.items.find((i) => i.boardId === boardId && i.values.syncId === syncId);
    return item ? { itemId: item.itemId } : null;
  }

  async createItem(boardId: string, itemName: string, values: MondayAttendanceColumnValues) {
    this.calls.create++;
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("כשל מדומה ב-create_item");
    }
    const itemId = String(this.nextId++);
    this.items.push({ itemId, boardId, name: itemName, values });
    return { itemId };
  }

  async updateItem(boardId: string, itemId: string, values: MondayAttendanceColumnValues) {
    this.calls.update++;
    const item = this.items.find((i) => i.boardId === boardId && i.itemId === itemId);
    if (!item) throw new Error(`פריט ${itemId} לא נמצא (מדומה)`);
    item.values = values;
  }

  /** מדמה "פריט שנוצר בניסיון קודם שקרס לפני ששמרנו ref מקומי" — לבדיקת איתור-לפני-יצירה. */
  seedExistingItem(boardId: string, syncId: string, name: string): string {
    const itemId = String(this.nextId++);
    this.items.push({ itemId, boardId, name, values: { syncId } as MondayAttendanceColumnValues });
    return itemId;
  }
}

async function run() {
  const boardId = getAttendanceBoardId(yochi.key)!;
  check("0. יוכי יש לוח Monday מוגדר (ר' מהחקירה בשלב א)", !!boardId, boardId);

  // ── 1: יום סגור טרי, אין ref מקומי, אין פריט ב-"Monday" → יוצר פריט חדש ────────────────────
  {
    const day = `${TEST_MONTH}-01`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportDayClose(yochi, at(day, "16:00"), seed());

    const client = new FakeMondayAttendanceClient();
    const dayRow = getDay(yochi.key, day)!;
    check("1a. monday_sync_status='not_synced' אחרי סגירה", dayRow.mondaySyncStatus === "not_synced");

    const result = await syncAttendanceDayToMonday(yochi.key, dayRow, client);
    check("1b. יצר פריט חדש (אין ref מקומי, אין פריט קיים ב-Monday)", result.action === "created" && !!result.itemId);
    check("1c. חיפש לפני שיצר (לפני יצירה בדוק אם קיים)", client.calls.find === 1 && client.calls.create === 1);
    check("1d. הפריט נוצר בלוח הנכון עם מזהה הסנכרון הנכון", client.items[0]?.boardId === boardId && client.items[0]?.values.syncId === buildAttendanceSyncId(yochi.key, day));
  }

  // ── 2: יש ref מקומי קיים → מעדכן את אותו פריט, לא יוצר ולא מחפש ────────────────────────────
  {
    const day = `${TEST_MONTH}-02`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportDayClose(yochi, at(day, "17:00"), seed());

    const client = new FakeMondayAttendanceClient();
    const existingItemId = client.seedExistingItem(boardId, buildAttendanceSyncId(yochi.key, day), "ישן");
    const dayWithRef = { ...getDay(yochi.key, day)!, mondaySyncRef: existingItemId };

    const result = await syncAttendanceDayToMonday(yochi.key, dayWithRef, client);
    check("2a. ref מקומי קיים → updated, לא created", result.action === "updated" && result.itemId === existingItemId);
    check("2b. לא חיפש כלל (יש ref, לא צריך) ולא יצר פריט נוסף", client.calls.find === 0 && client.calls.create === 0 && client.calls.update === 1);
    check("2c. עדיין פריט בודד בלוח", client.items.length === 1);
  }

  // ── 3 (הבדיקה המרכזית — idempotency מול Monday עצמו): אין ref מקומי (כאילו קרס אחרי create
  //     ולפני שמירה), אבל פריט *כבר קיים* ב-Monday עם אותו syncId → מאמץ אותו, לא יוצר כפילות ──
  {
    const day = `${TEST_MONTH}-03`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportDayClose(yochi, at(day, "16:30"), seed());

    const client = new FakeMondayAttendanceClient();
    const preExisting = client.seedExistingItem(boardId, buildAttendanceSyncId(yochi.key, day), "15/06/2030");
    const dayNoRef = getDay(yochi.key, day)!; // mondaySyncRef הוא null במקור

    const result = await syncAttendanceDayToMonday(yochi.key, dayNoRef, client);
    check("3a. אימץ את הפריט הקיים (adopted_existing), לא יצר", result.action === "adopted_existing" && result.itemId === preExisting);
    check("3b. create_item לא נקרא בכלל", client.calls.create === 0);
    check("3c. עדיין פריט בודד בלוח (אין כפילות)", client.items.length === 1);
  }

  // ── 4: runAttendanceMondaySync (ה-job המלא) — claim/finalize, ושתי ריצות רצופות לא כותבות כפול ─
  {
    const day = `${TEST_MONTH}-04`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportDayClose(yochi, at(day, "16:00"), seed());

    const client = new FakeMondayAttendanceClient();
    const run1 = await runAttendanceMondaySync(client, TEST_USERS);
    check("4a. ריצה ראשונה: checked>=1, synced>=1", run1.checked >= 1 && run1.synced >= 1, JSON.stringify(run1));
    const dayAfter1 = getDay(yochi.key, day)!;
    check("4b. monday_sync_status='synced' ו-ref נשמר מקומית", dayAfter1.mondaySyncStatus === "synced" && !!dayAfter1.mondaySyncRef);
    const itemCountAfter1 = client.items.length;

    const run2 = await runAttendanceMondaySync(client, TEST_USERS); // היום הזה כבר synced — לא אמור להיבחר שוב
    check("4c. ריצה שנייה: היום הסונכרן לא נבחר שוב (כבר synced)", !client.items.some((i, idx) => idx >= itemCountAfter1));
    void run2;
  }

  // ── 5: תיקון שעות *אחרי* סנכרון → מסומן not_synced מחדש → ה-resync מעדכן את *אותו* פריט ─────
  {
    const day = `${TEST_MONTH}-05`;
    checkAttendanceDayStart(yochi, at(day, "09:00")); // רצה 09:00 בטעות, תיקון בהמשך ל-08:45
    reportDayClose(yochi, at(day, "16:00"), seed());

    const client = new FakeMondayAttendanceClient();
    await runAttendanceMondaySync(client, TEST_USERS);
    const refAfterFirstSync = getDay(yochi.key, day)!.mondaySyncRef;
    check("5a. סונכרן בפעם הראשונה, יש ref", !!refAfterFirstSync);

    const openEvent = listEventsForDay(yochi.key, day).find((e) => e.eventType === "day_open")!;
    const corrected = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "day_open",
      newReportedForAtUtcIso: at(day, "08:45").toUTC().toISO()!,
      messageSeed: seed(),
    });
    check("5b. תיקון עצמי אוטומטי (חודש פתוח)", corrected.ok && corrected.correction?.status === "applied");
    check("5c. אחרי תיקון — monday_sync_status חזר ל-not_synced", getDay(yochi.key, day)?.mondaySyncStatus === "not_synced");
    check("5d. ref המקומי נשאר (לא נמחק ע״י התיקון)", getDay(yochi.key, day)?.mondaySyncRef === refAfterFirstSync);

    const itemCountBefore = client.items.length;
    const run2 = await runAttendanceMondaySync(client, TEST_USERS);
    check("5e. ריצה שנייה סינכרנה את התיקון", run2.synced >= 1);
    check("5f. *אותו* פריט עודכן — לא נוסף פריט חדש", client.items.length === itemCountBefore, `before=${itemCountBefore} after=${client.items.length}`);
    check("5g. הערך המעודכן שיקף את התיקון (08:45)", client.items.find((i) => i.itemId === refAfterFirstSync)?.values.firstInLocal?.hour === 8);
    void openEvent;
  }

  // ── 6: כשל זמני (Monday API "נופל") → מסומן failed, retry בריצה הבאה מצליח ────────────────────
  {
    const day = `${TEST_MONTH}-06`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportDayClose(yochi, at(day, "16:00"), seed());

    const client = new FakeMondayAttendanceClient();
    client.failNextCreate = true;
    const run1 = await runAttendanceMondaySync(client, TEST_USERS);
    check("6a. ריצה ראשונה: נכשלה (failed>=1)", run1.failed >= 1, JSON.stringify(run1));
    check("6b. monday_sync_status='failed' (לא תקוע ב-pending)", getDay(yochi.key, day)?.mondaySyncStatus === "failed");

    const run2 = await runAttendanceMondaySync(client, TEST_USERS); // בלי failNextCreate — אמור להצליח
    check("6c. ריצה שנייה (retry): הצליחה", run2.synced >= 1, JSON.stringify(run2));
    check("6d. monday_sync_status='synced' אחרי ה-retry", getDay(yochi.key, day)?.mondaySyncStatus === "synced");
    check("6e. נוצר פריט בודד בלבד (לא כפול מהניסיון שנכשל)", client.items.length === 1, String(client.items.length));
  }

  // ── 7: קריסה תוך-כדי ריצת job (claim בלי finalize) → recoverStuckAttendanceMondaySyncs ──────
  {
    const day = `${TEST_MONTH}-07`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportDayClose(yochi, at(day, "16:00"), seed());
    db.prepare(`UPDATE attendance_days SET monday_sync_status='pending' WHERE user_key=? AND work_date=?`).run(yochi.key, day);

    const client = new FakeMondayAttendanceClient();
    const runWhileStuck = await runAttendanceMondaySync(client, TEST_USERS);
    check("7a. בזמן שתקוע ב-pending, לא נבחר ל-job (claim נכשל)", !client.items.some((i) => i.values.syncId === buildAttendanceSyncId(yochi.key, day)));
    void runWhileStuck;

    const recovered = recoverStuckAttendanceMondaySyncs();
    check("7b. recoverStuckAttendanceMondaySyncs שחזר לפחות שורה אחת", recovered >= 1, String(recovered));
    check("7c. אחרי השחזור — not_synced (לא pending)", getDay(yochi.key, day)?.mondaySyncStatus === "not_synced");

    const runAfterRecovery = await runAttendanceMondaySync(client, TEST_USERS);
    check("7d. אחרי השחזור, ה-job מסנכרן בהצלחה", runAfterRecovery.synced >= 1);
    check("7e. פריט בודד בלבד נוצר (אין כפילות מהקריסה)", client.items.filter((i) => i.values.syncId === buildAttendanceSyncId(yochi.key, day)).length === 1);
  }

  // ── 8: חודש שכר סגור — תיקון ממתין למוטי, לא מסונכרן עד שמאושר ──────────────────────────────
  {
    const day = `${TEST_MONTH}-08`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportDayClose(yochi, at(day, "16:00"), seed());
    const client = new FakeMondayAttendanceClient();
    await runAttendanceMondaySync(client, TEST_USERS);
    const refBefore = getDay(yochi.key, day)!.mondaySyncRef;

    closePayrollMonth(TEST_MONTH, "moti");
    const closeEvent = listEventsForDay(yochi.key, day).find((e) => e.eventType === "day_close")!;
    requestAttendanceCorrection(yochi, { workDate: day, field: "day_close", newReportedForAtUtcIso: at(day, "16:30").toUTC().toISO()!, messageSeed: seed() });
    check("8a. תיקון בחודש סגור לא הפך את היום ל-not_synced (עדיין ממתין למוטי, לא הוחל)", getDay(yochi.key, day)?.mondaySyncStatus === "synced");
    check("8b. ref המקומי לא השתנה (שום דבר לא סונכרן כי שום דבר לא הוחל עדיין)", getDay(yochi.key, day)?.mondaySyncRef === refBefore);
    void closeEvent;
    reopenPayrollMonth(TEST_MONTH, "moti");
  }

  // ── 9: allowlist פיילוט — יום סגור של משתמש *שלא* ברשימת הפיילוט לא מסונכרן בכלל ─────────────
  {
    const day = `${TEST_MONTH}-09`;
    checkAttendanceDayStart(dov, at(day, "09:00"));
    reportDayClose(dov, at(day, "16:00"), seed());
    check("9a. היום של dov נסגר מקומית (closed, not_synced)", getDay(dov.key, day)?.status === "closed" && getDay(dov.key, day)?.mondaySyncStatus === "not_synced");

    const client = new FakeMondayAttendanceClient();
    const run1 = await runAttendanceMondaySync(client, TEST_USERS); // TEST_USERS=["yochi"] בלבד — dov לא ברשימה
    check("9b. היום של dov לא נספר ב-checked (לא ברשימת הפיילוט שהועברה)", !client.items.some((i) => i.values.syncId === buildAttendanceSyncId(dov.key, day)));
    check("9c. אפס קריאה ל-Monday עבור dov (create_item לא נקרא בכלל עבורו)", client.calls.create === 0 && client.calls.find === 0);
    check("9d. monday_sync_status של dov נשאר not_synced (לא pending/synced/failed)", getDay(dov.key, day)?.mondaySyncStatus === "not_synced");
    void run1;
  }

  cleanup();
}

await run();
