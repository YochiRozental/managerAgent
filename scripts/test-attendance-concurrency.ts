/**
 * מודול נוכחות — תיקון ממצא 2 (audit שלב ה, 2026-10-11): clientMessageId (channelMessageId) הוא
 * עכשיו המזהה הראשי ב-ops/chat.ts, לא turnOrdinal. הקובץ הזה בודק שהתיקון בפועל פותר את מה
 * שדווח: שתי הודעות *שונות אבל אמיתיות* (שתי לשוניות, לא resend) מקבלות מזהים שונים ולעולם לא
 * מתמזגות בשקט — גם כש-התוכן זהה, גם כש-נקראות ללא שום הפרש זמן.
 *
 *   npm run test:attendance-concurrency
 *
 * READ-ONLY מול Monday (אין קריאה בכלל).
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { logger } from "../src/utils/logger.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { buildMessageIdempotencySeed } from "../src/ops/attendanceEngine.js";
import { checkAttendanceDayStart, reportBreakStart, requestAttendanceCorrection, reportDayClose } from "../src/ops/attendance.js";
import { getDay } from "../src/db/repositories/attendanceDays.js";
import { listEventsForDay } from "../src/db/repositories/attendanceEvents.js";
import { listCorrectionsForUser } from "../src/db/repositories/attendanceCorrections.js";

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

function cleanup(): void {
  const placeholders = TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_corrections WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
}
cleanup();

const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });
// שתי "לשוניות" = שני clientMessageId שונים (crypto.randomUUID() בפועל ב-ui.html) — ללא שום תלות
// ב-session/history, גם אם התוכן שהן שולחות זהה מילה-במילה.
const tabSeed = (clientMessageId: string) => buildMessageIdempotencySeed({ scopeId: "irrelevant-now", channelMessageId: clientMessageId });

async function run() {
  // ── תרחיש 1 (לשעבר ממצא בעייתי, לא יותר): שני break_start משתי לשוניות עם מזהים שונים ────
  // עכשיו: לא מתמזגים בשקט. הראשון מצליח, השני מקבל דחייה ברורה מה-state machine (לא "הצלחה"
  // מזויפת, לא איחוד שקט) — כי כל אחד מהם רץ כפעולה עצמאית עם idempotency key משלו.
  {
    const day = "2032-01-10";
    checkAttendanceDayStart(yochi, at(day, "09:00"));

    const seedTabA = tabSeed("11111111-aaaa-aaaa-aaaa-111111111111");
    const seedTabB = tabSeed("22222222-bbbb-bbbb-bbbb-222222222222");
    check("1a. שני clientMessageId שונים → שני messageSeed שונים", seedTabA !== seedTabB);

    const resultTabA = reportBreakStart(yochi, at(day, "12:00"), seedTabA);
    const resultTabB = reportBreakStart(yochi, at(day, "12:00"), seedTabB); // "לשונית אחרת" — לא resend

    check("1b. לשונית א הצליחה", resultTabA.ok, resultTabA.message);
    check("1c. לשונית ב קיבלה דחייה ברורה (לא הצלחה מזויפת, לא מיזוג שקט)", !resultTabB.ok, resultTabB.message);
    check("1d. הודעת הדחייה ברורה למשתמש (לא שגיאה גנרית)", resultTabB.message.includes("כבר בהפסקה"));

    const events = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_start");
    check("1e. רק אירוע break_start אחד נכתב בפועל", events.length === 1);

    reportDayClose(yochi, at(day, "16:00"), tabSeed("33333333-cccc-cccc-cccc-333333333333"));
  }

  // ── תרחיש 2 (הממצא האמיתי מהדוח הקודם, עכשיו נבדק אחרי התיקון): שתי בקשות תיקון *בתוכן שונה*
  // (09:00 מול 08:45) משתי לשוניות — עם מזהים שונים. התוצאה הרצויה: שתיהן מתועדות (לא נדרס/
  // אבד בשקט), סדר עיבוד מוגדר (last-applied-wins בחישוב בפועל) — בדיוק כנדרש (סעיף 10). ───────
  {
    const day = "2032-01-11";
    checkAttendanceDayStart(yochi, at(day, "10:00")); // רצה 10:00 בטעות
    reportDayClose(yochi, at(day, "16:00"), tabSeed("44444444-dddd-dddd-dddd-444444444444"));

    const seedTabA = tabSeed("55555555-eeee-eeee-eeee-555555555555");
    const seedTabB = tabSeed("66666666-ffff-ffff-ffff-666666666666");

    const correctionA = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "day_open",
      newReportedForAtUtcIso: at(day, "09:00").toUTC().toISO()!,
      messageSeed: seedTabA,
    });
    const correctionB = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "day_open",
      newReportedForAtUtcIso: at(day, "08:45").toUTC().toISO()!, // ערך *אחר* — החלטה אמיתית שונה
      messageSeed: seedTabB,
    });

    check("2a. בקשה א הוחלה", correctionA.ok && correctionA.correction?.status === "applied");
    check("2b. בקשה ב *גם* הוחלה — לא נדרסה/נבלעה כ-retry של א", correctionB.ok && correctionB.correction?.status === "applied");
    check("2c. שתי בקשות תיקון *נפרדות* נשמרו ביומן הביקורת — אין אובדן שקט", correctionB.correction?.id !== correctionA.correction?.id);

    const dayCorrections = listCorrectionsForUser(yochi.key).filter((c) => c.workDate === day);
    check("2d. שתי השורות קיימות בפועל ב-attendance_corrections", dayCorrections.length === 2, String(dayCorrections.length));

    // סדר עיבוד מוגדר: מי שהוחל *אחרון* (id גבוה יותר) הוא הערך בפועל ב-summary — לא ניחוש,
    // תוצאה דטרמיניסטית של סדר ה-overlay (ר' attendanceEngine.ts applyCorrections).
    const finalOpenTime = getDay(yochi.key, day)?.openedReportedAt;
    const lastApplied = dayCorrections.sort((a, b) => b.id - a.id)[0]!;
    check("2e. הערך הסופי בפועל = הבקשה שהוחלה אחרונה (סדר עיבוד מוגדר, לא שקט)", finalOpenTime === lastApplied.newValue, `final=${finalOpenTime} lastApplied=${lastApplied.newValue}`);
  }

  // ── תרחיש 3: retry אמיתי (לא "לשונית אחרת") — אותו clientMessageId בדיוק, קרה פעמיים ────────
  // (כמו שה-UI עושה בפועל על timeout) — חייב להישאר אידמפוטנטי, לא להיחשב "תרחיש 1".
  {
    const day = "2032-01-12";
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    const retrySeed = tabSeed("77777777-0000-0000-0000-777777777777");
    const r1 = reportBreakStart(yochi, at(day, "12:00"), retrySeed);
    const r2 = reportBreakStart(yochi, at(day, "12:00"), retrySeed); // *אותו* clientMessageId — retry אמיתי
    check("3a. ניסיון ראשון הצליח", r1.ok);
    check("3b. retry (אותו מזהה בדיוק) לא נכשל — idempotent, לא 'כבר בהפסקה'", r2.ok, r2.message);
    const events = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_start");
    check("3c. עדיין אירוע יחיד (retry לא כתב שני)", events.length === 1);
    reportDayClose(yochi, at(day, "16:00"), tabSeed("88888888-1111-1111-1111-888888888888"));
  }

  cleanup();
}

run()
  .then(() => {
    if (failed > 0) {
      logger.error(`${failed} בדיקות נכשלו`);
      process.exit(1);
    }
    logger.info("כל הבדיקות עברו ✅ — התיקון (clientMessageId כמזהה ראשי) פותר את ממצא 2 מהדוח הקודם.");
  })
  .catch((err) => {
    logger.error({ err }, "בדיקה קרסה");
    process.exit(1);
  });
