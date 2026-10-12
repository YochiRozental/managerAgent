/**
 * מודול נוכחות — שלב ג, בדיקות אינטגרציה מול DB מקומי אמיתי. אפס Monday אמיתי (אין קוד סנכרון
 * Monday בשלב הזה כלל). תאריכים פיקטיביים ב-2030 כדי לא להתנגש בדאטה אמיתי.
 *
 *   npm run test:attendance
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { logger } from "../src/utils/logger.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { buildMessageIdempotencySeed } from "../src/ops/attendanceEngine.js";
import {
  checkAttendanceDayStart,
  reportBreakStart,
  reportBreakEnd,
  reportDayClose,
  setAttendanceReminderTime,
  requestAttendanceCorrection,
  decideAttendanceCorrection,
} from "../src/ops/attendance.js";
import { getDay } from "../src/db/repositories/attendanceDays.js";
import { listEventsForDay } from "../src/db/repositories/attendanceEvents.js";
import { getReminderPref } from "../src/db/repositories/attendanceReminderPrefs.js";
import { listUnseenNotifications, addNotification as realAddNotification } from "../src/db/repositories/notifications.js";
import { closePayrollMonth, reopenPayrollMonth } from "../src/db/repositories/payrollMonths.js";
import { getCorrection, listCorrectionsForUser } from "../src/db/repositories/attendanceCorrections.js";
import { runAttendanceReminderTick, sendAttendanceReminder, type SendReminderDeps } from "../src/ops/attendanceReminderScheduler.js";
import type { StoredAttendanceDay } from "../src/db/repositories/attendanceDays.js";
import { appendChatTurn, countUserMessagesInSession, deleteSession } from "../src/db/repositories/chatHistory.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const yochi = resolveUserByKey("yochi")!;
const dov = resolveUserByKey("dov")!;
const moti = resolveUserByKey("moti")!;
const TEST_USERS = ["yochi", "dov"];
const TEST_MONTH = "2030-03";

function cleanup(): void {
  const placeholders = TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_reminder_prefs WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_corrections WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM notifications WHERE user_key IN (${placeholders}) AND kind = 'attendance_reminder'`).run(...TEST_USERS);
  db.prepare(`DELETE FROM payroll_month_locks WHERE month = ?`).run(TEST_MONTH);
}
cleanup();

const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });
/** נוח: seed ייחודי פר-"הודעה" מדומה — session קבוע, היסטוריה עם טקסט ייחודי כדי לא להתנגש בין בדיקות. */
// מדמה turnOrdinal אמיתי (countUserMessagesInSession): כל (session,text) שלא נראה קודם מקבל
// ordinal חדש בתוך אותה session; אותו (session,text) בדיוק (retry מכוון בבדיקות) מקבל את אותו
// ordinal שהוקצה לו בפעם הראשונה — בלי תלות ב-history, בדיוק כמו ההתנהגות האמיתית.
const turnCounters = new Map<string, number>();
const seenTurns = new Map<string, number>();
function seed(sessionId: string, text: string): string {
  const key = `${sessionId}:${text}`;
  let ordinal = seenTurns.get(key);
  if (ordinal === undefined) {
    ordinal = turnCounters.get(sessionId) ?? 0;
    turnCounters.set(sessionId, ordinal + 1);
    seenTurns.set(key, ordinal);
  }
  return buildMessageIdempotencySeed({ scopeId: sessionId, turnOrdinal: ordinal });
}

// ── 1+2: הודעה ראשונה פותחת נוכחות, שנייה לא פותחת שוב ─────────────────────────
{
  const day1 = "2030-03-11";
  const r1 = checkAttendanceDayStart(yochi, at(day1, "09:00"));
  check("1. הודעה ראשונה פותחת יום + בנר עם 'בוקר טוב'", !!r1.banner && r1.banner.includes("בוקר טוב"), r1.banner ?? "null");
  check("1b. בנר ראשון שואל שעת תזכורת (פעם ראשונה)", !!r1.banner?.includes("באיזו שעה"));
  const d1 = getDay(yochi.key, day1);
  check("1c. attendance_days נוצר עם status=open", d1?.status === "open");

  const r2 = checkAttendanceDayStart(yochi, at(day1, "11:00"));
  check("2. הודעה שנייה באותו יום — banner=null (לא פותח שוב)", r2.banner === null);
  check("2b. עדיין רק אירוע day_open יחיד", listEventsForDay(yochi.key, day1).filter((e) => e.eventType === "day_open").length === 1);
}

// ── 3: יום סגור לא נפתח מחדש אוטומטית ──────────────────────────────────────────
{
  const day1 = "2030-03-11";
  const close = reportDayClose(yochi, at(day1, "17:00"), seed("s1", "סיימתי"));
  check("3a. סגירת יום הראשון הצליחה", close.ok, close.message);
  const r = checkAttendanceDayStart(yochi, at(day1, "18:00"));
  check("3b. בדיקה חוזרת אחרי סגירה — banner=null, לא נפתח מחדש", r.banner === null);
  check("3c. היום נשאר closed", getDay(yochi.key, day1)?.status === "closed");
}

// ── 13: מעבר חצות ──────────────────────────────────────────────────────────────
{
  const dayA = "2030-03-12";
  const dayB = "2030-03-13";
  checkAttendanceDayStart(yochi, at(dayA, "09:00"));
  const r = checkAttendanceDayStart(yochi, at(dayB, "08:30"));
  check("13a. יום חדש אחרי חצות נפתח כרגיל", !!r.banner);
  check("13b. בנר כולל אזהרה על היום הקודם שנשאר פתוח", !!r.banner?.includes(dayA));
  check("13c. היום הקודם סומן pending_completion", getDay(yochi.key, dayA)?.status === "pending_completion");
  check("13d. היום החדש נפתח בנפרד, open", getDay(yochi.key, dayB)?.status === "open");
  reportDayClose(yochi, at(dayB, "16:00"), seed("s13", "סיימתי"));
}

// ── 4+5: יציאה וחזרה אחת / מספר יציאות וחזרות ──────────────────────────────────
{
  const day = "2030-03-14";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  reportBreakStart(yochi, at(day, "12:30"), seed("s4", "יצאתי"));
  reportBreakEnd(yochi, at(day, "13:15"), seed("s4", "חזרתי"));
  const close = reportDayClose(yochi, at(day, "16:00"), seed("s4", "סיימתי"));
  check("4. יציאה-חזרה אחת: נטו 6 שעות ו-15 דקות בטקסט", close.message.includes("6 שעות ו-15 דקות"), close.message);
  check("4b. הפסקות: 45 דקות בטקסט", close.message.includes("45 דקות"), close.message);
}

// ── 6: יציאה כפולה / 7: חזרה בלי יציאה / 8: סיום כפול ──────────────────────────
{
  const day = "2030-03-15";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  const r1 = reportBreakStart(yochi, at(day, "12:00"), seed("s6", "יצאתי-1"));
  const r2 = reportBreakStart(yochi, at(day, "12:05"), seed("s6", "יצאתי-2"));
  check("6a. יציאה ראשונה הצליחה", r1.ok);
  check("6b. יציאה שנייה (כפולה, לא retry — seed אחר) נדחתה ע״י ה-state machine", !r2.ok, r2.message);
  reportBreakEnd(yochi, at(day, "12:30"), seed("s6", "חזרתי"));
  reportDayClose(yochi, at(day, "16:00"), seed("s6", "סיימתי"));
}
{
  const day = "2030-03-16";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  const r = reportBreakEnd(yochi, at(day, "10:00"), seed("s7", "חזרתי"));
  check("7. break_end בלי break_start קודם נדחה", !r.ok, r.message);
  reportDayClose(yochi, at(day, "16:00"), seed("s7", "סיימתי"));
}
{
  const day = "2030-03-17";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  const r1 = reportDayClose(yochi, at(day, "16:00"), seed("s8", "סיימתי-1"));
  const r2 = reportDayClose(yochi, at(day, "16:05"), seed("s8", "סיימתי-2"));
  check("8a. סיום יום ראשון הצליח", r1.ok);
  check("8b. סיום יום שני (כפול, seed אחר) נדחה", !r2.ok, r2.message);
}

// ── 9: שכחה לסגור יום ──────────────────────────────────────────────────────────
{
  const day = "2030-03-18";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  const dd = getDay(yochi.key, day);
  check("9. יום בלי day_close נשאר open (net=null)", dd?.status === "open" && dd?.netMinutes === null);
}

// ── audit שלב ד: countUserMessagesInSession יציב בין ניסיון מקורי ל-retry *גם אם ה-history*
// *שהתקבל בבקשה השתנה ביניהם* — זה בדיוק התיקון המרכזי שהתבקש (לעומת הגרסה הקודמת שגיבבה history). ─
{
  const testSession = "test-idempotency-session-" + Date.now();
  deleteSession(yochi.key, testSession); // ניקוי אם רץ קודם

  const ordinalBefore1 = countUserMessagesInSession(yochi.key, testSession);
  check("ordinal: שיחה חדשה — 0 הודעות קודמות", ordinalBefore1 === 0);

  // "ניסיון מקורי": history מגיע עם 3 הודעות (אולי נקטע/שונה מה-session האמיתי) — ה-ordinal
  // *לא תלוי בזה בכלל*, רק בכמה הודעות-משתמש *כבר נשמרו בפועל* לפני הקריאה הזו.
  const ordinalAttempt1 = countUserMessagesInSession(yochi.key, testSession);
  // "קריסה" מדומה: הניסיון הראשון לא הגיע ל-appendChatTurn (כאילו קרס/timeout) — שום דבר לא נשמר.
  // "ניסיון חוזר" (retry): history שהתקבל בבקשה הזו *שונה בתכלית* (למשל נטען מחדש עם עוד הודעות
  // ישנות, או נקטע אחרת) — אבל ordinal עדיין מחושב מה-DB, לא מה-history, אז הוא זהה.
  const ordinalAttempt2_withDifferentHistory = countUserMessagesInSession(yochi.key, testSession);
  check("ordinal: זהה בין 'ניסיון מקורי' ל-'retry' גם כש-history (לא קיים כפרמטר כלל) היה משתנה", ordinalAttempt1 === ordinalAttempt2_withDifferentHistory);

  // הניסיון השני "מצליח" ונשמר בפועל (appendChatTurn — בדיוק כמו server/index.ts אחרי שה-handler חוזר)
  appendChatTurn(yochi.key, testSession, "יצאתי", "רשמתי — יצאת ב-09:10", []);
  const ordinalAfterCommit = countUserMessagesInSession(yochi.key, testSession);
  check("ordinal: עלה ב-1 אחרי שהודעה *נשמרה בפועל* (הודעה חדשה אמיתית, לא עוד retry)", ordinalAfterCommit === ordinalAttempt1 + 1);

  deleteSession(yochi.key, testSession);
}

// ── 1 (idempotency המרכזי): שתי פעולות לגיטימיות *באותה דקה בפועל* — שתיהן נכתבות ──────
{
  const day = "2030-03-22";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  // שני מחזורי הפסקה נפרדים, שניהם break_start נופלים באותה דקה (09:10) — היה מתנגש עם דלי-דקה הישן
  const bs1 = reportBreakStart(yochi, at(day, "09:10"), seed("s22", "יצאתי-א"));
  const be1 = reportBreakEnd(yochi, at(day, "09:10"), seed("s22", "חזרתי-א"));
  const bs2 = reportBreakStart(yochi, at(day, "09:10"), seed("s22", "יצאתי-ב"));
  const be2 = reportBreakEnd(yochi, at(day, "09:10"), seed("s22", "חזרתי-ב"));
  check("same-minute 1/4: break_start ראשון הצליח", bs1.ok, bs1.message);
  check("same-minute 2/4: break_end ראשון הצליח", be1.ok, be1.message);
  check("same-minute 3/4: break_start שני (אותה דקה!) הצליח — לא נחסם ע״י דלי-זמן", bs2.ok, bs2.message);
  check("same-minute 4/4: break_end שני הצליח", be2.ok, be2.message);
  const dd = getDay(yochi.key, day);
  check("same-minute: 2 מקטעי הפסקה נרשמו (לא 1)", dd?.segmentCount === 2, String(dd?.segmentCount));
  reportDayClose(yochi, at(day, "16:00"), seed("s22", "סיימתי"));
}

// ── retry אמיתי: אותו messageSeed בדיוק (resend) → לא נוצר אירוע כפול ──────────────
{
  const day = "2030-03-23";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  const retrySeed = seed("s23", "יצאתי");
  reportBreakStart(yochi, at(day, "12:00"), retrySeed);
  const retried = reportBreakStart(yochi, at(day, "12:00"), retrySeed); // "אותה הודעה" ממש — retry
  check("retry: הניסיון השני לא נכשל (idempotent, לא state-machine error)", retried.ok, retried.message);
  const events = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_start");
  check("retry: רק אירוע break_start אחד בפועל נכתב", events.length === 1, String(events.length));
  reportBreakEnd(yochi, at(day, "12:30"), seed("s23", "חזרתי"));
  reportDayClose(yochi, at(day, "16:00"), seed("s23", "סיימתי"));
}

// ── 10+12: תזכורת בשעה האישית + מניעת כפילות ────────────────────────────────────
{
  const day = "2030-03-19";
  setAttendanceReminderTime(yochi, 14, 30);
  check("10a. שעת תזכורת נשמרה", getReminderPref(yochi.key)?.reminderHour === 14);
  checkAttendanceDayStart(yochi, at(day, "09:00"));

  const sentCount1 = await runAttendanceReminderTick(at(day, "14:30"));
  check("10b. התזכורת נשלחה בשעה המדויקת (יום פתוח)", sentCount1 >= 1, String(sentCount1));
  const unseen = listUnseenNotifications(yochi.key).filter((n) => n.kind === "attendance_reminder");
  check("10c. נוצרה notification מסוג attendance_reminder", unseen.length === 1, String(unseen.length));
  check("10d. תוכן התזכורת תואם לנוסח המבוקש", unseen[0]?.body.includes("שעון הנוכחות שלך עדיין פעיל") ?? false);

  const sentCount2 = await runAttendanceReminderTick(at(day, "14:31"));
  check("12. טיק נוסף לא שולח תזכורת כפולה", sentCount2 === 0, String(sentCount2));
  check("12b. עדיין רק notification אחת", listUnseenNotifications(yochi.key).filter((n) => n.kind === "attendance_reminder").length === 1);

  reportDayClose(yochi, at(day, "17:00"), seed("s10", "סיימתי"));
}
{
  setAttendanceReminderTime(yochi, 17, 45);
  check("11. שינוי שעת תזכורת נשמר (17:45)", getReminderPref(yochi.key)?.reminderHour === 17);
}
{
  const day = "2030-03-20";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  reportDayClose(yochi, at(day, "16:00"), seed("s20", "סיימתי"));
  const sent = await runAttendanceReminderTick(at(day, "17:45"));
  check("תזכורת לא נשלחת ליום שכבר נסגר", sent === 0, String(sent));
}

// ── התאוששות תזכורת מהפעלה מחדש — pending_send תקוע נשוחזר ל-none, נשלח פעם אחת בלבד ─────
{
  const day = "2030-03-24";
  setAttendanceReminderTime(yochi, 10, 0);
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  // מדמה קריסה: תהליך תפס (claim) ולא הגיע ל-markReminderSent/revert לפני שנפל.
  db.prepare(`UPDATE attendance_days SET reminder_status='pending_send' WHERE user_key=? AND work_date=?`).run(yochi.key, day);
  const stuckBefore = await runAttendanceReminderTick(at(day, "10:05"));
  check("recovery: בזמן שתקוע ב-pending_send, טיק רגיל לא שולח (לא 'מאשר שליחה' לבד)", stuckBefore === 0, String(stuckBefore));

  // "הפעלה מחדש" — startAttendanceReminderSchedule מריץ את זה; כאן קוראים ישירות לפונקציה.
  const { recoverStuckAttendanceReminders } = await import("../src/db/repositories/attendanceDays.js");
  const recovered = recoverStuckAttendanceReminders();
  check("recovery: recoverStuckAttendanceReminders שחזר לפחות שורה אחת", recovered >= 1, String(recovered));

  const sentAfterRecovery = await runAttendanceReminderTick(at(day, "10:06"));
  check("recovery: אחרי שחזור, הטיק שולח בדיוק פעם אחת", sentAfterRecovery === 1, String(sentAfterRecovery));
  const sentTwice = await runAttendanceReminderTick(at(day, "10:07"));
  check("recovery: טיק נוסף לא שולח שוב (אין כפילות אחרי ההתאוששות)", sentTwice === 0, String(sentTwice));
  reportDayClose(yochi, at(day, "16:00"), seed("s24", "סיימתי"));
}

// ── audit שלב ד (ב): קריסה *בתוך* הטרנזקציה (אחרי שה-notification נכתב בפועל, לפני markReminderSent)
// — מוכיח שה-ROLLBACK מבטל גם את ה-notification שכבר נכתב באותה טרנזקציה, לא רק את הסימון. ────
{
  const day = "2030-03-26";
  setAttendanceReminderTime(yochi, 11, 0);
  checkAttendanceDayStart(yochi, at(day, "09:00"));

  let capturedNotifId: number | null = null;
  const crashDeps: SendReminderDeps = {
    // מריץ את ה-addNotification *האמיתי* (כתיבה בפועל ל-DB, בתוך הטרנזקציה) ואז זורק — מדמה
    // קריסה בדיוק בין כתיבת ההתראה לכתיבת markReminderSent, שתיהן עדיין בתוך אותו runInTransaction.
    addNotification: (userKey, kind, body) => {
      const id = realAddNotification(userKey, kind, body);
      capturedNotifId = id;
      throw new Error("קריסה מדומה — אחרי כתיבת ה-notification, לפני markReminderSent");
    },
  };
  const result = await sendAttendanceReminder({ userKey: yochi.key, workDate: day } as StoredAttendanceDay, crashDeps);
  check("קריסה-בתוך-טרנזקציה: sendAttendanceReminder מחזיר false", result === false);
  check("קריסה-בתוך-טרנזקציה: notifId נלכד (ה-insert רץ בפועל לפני הזריקה)", capturedNotifId !== null);
  const stillExists = capturedNotifId != null ? db.prepare(`SELECT 1 FROM notifications WHERE id = ?`).get(capturedNotifId) : "n/a";
  check("קריסה-בתוך-טרנזקציה: ROLLBACK ביטל את ה-notification שכבר נכתב — לא קיים בפועל", !stillExists, JSON.stringify(stillExists));
  check("קריסה-בתוך-טרנזקציה: reminder_status חזר ל-none (לא תקוע)", getDay(yochi.key, day)?.reminderStatus === "none" || getDay(yochi.key, day) === null);

  // עכשיו טיק רגיל אמור לעבוד כרגיל ולשלוח בדיוק פעם אחת — אין "זיכרון" לקריסה הקודמת
  const sentAfterCrash = await runAttendanceReminderTick(at(day, "11:00"));
  check("קריסה-בתוך-טרנזקציה: טיק רגיל אחרי הקריסה שולח כרגיל (לא תקוע)", sentAfterCrash === 1, String(sentAfterCrash));
  const sentAgain = await runAttendanceReminderTick(at(day, "11:01"));
  check("קריסה-בתוך-טרנזקציה: אין כפילות — טיק נוסף לא שולח שוב", sentAgain === 0, String(sentAgain));
  reportDayClose(yochi, at(day, "16:00"), seed("s26", "סיימתי"));
}

// ── 18: תיקון/השלמה רטרואקטיבית — כל הדוגמאות מהבקשה ────────────────────────────

// "התחילתי היום בתשע ולא בעשר" — תיקון ערך לאירוע קיים (day_open)
{
  const day = `${TEST_MONTH}-05`;
  checkAttendanceDayStart(yochi, at(day, "10:00")); // רצה 09:00 בטעות
  reportDayClose(yochi, at(day, "16:00"), seed("s18a", "סיימתי"));

  const r1 = requestAttendanceCorrection(yochi, {
    workDate: day,
    field: "day_open",
    newReportedForAtUtcIso: at(day, "09:00").toUTC().toISO()!,
    reason: "בדיקה",
    messageSeed: seed("s18a", "התחלתי בתשע ולא בעשר"),
  });
  check("18a. תיקון עצמי בחודש פתוח — applied אוטומטית", r1.ok && r1.correction?.status === "applied", JSON.stringify(r1));
  check("18a2. netMinutes עודכן (09:00-16:00=420)", getDay(yochi.key, day)?.netMinutes === 420, String(getDay(yochi.key, day)?.netMinutes));
  const openEvent = listEventsForDay(yochi.key, day).find((e) => e.eventType === "day_open")!;
  check("18a3. האירוע המקורי (10:00) לא נמחק/לא השתנה — append-only אמיתי", openEvent.reportedForAt === at(day, "10:00").toUTC().toISO());
  check(
    "18a4. נכתב אירוע correction נפרד שמצביע על המקורי",
    listEventsForDay(yochi.key, day).some((e) => e.eventType === "correction" && e.correctsEventId === openEvent.id),
  );

  // retry של בדיוק אותה בקשת תיקון — לא יוצר שורה שנייה ולא מחיל פעמיים
  const r1retry = requestAttendanceCorrection(yochi, {
    workDate: day,
    field: "day_open",
    newReportedForAtUtcIso: at(day, "09:00").toUTC().toISO()!,
    reason: "בדיקה",
    messageSeed: seed("s18a", "התחלתי בתשע ולא בעשר"),
  });
  check("18a5. retry של בקשת תיקון — לא יוצר בקשה שנייה", r1retry.correction?.id === r1.correction?.id);
  check("18a6. retry — עדיין רק אירוע correction יחיד לאותו field", listEventsForDay(yochi.key, day).filter((e) => e.eventType === "correction").length === 1);
}

// "שכחתי לדווח שחזרתי מההפסקה" — השלמה (אין אירוע קיים מהסוג הזה כרגע פתוח → תוספת)
{
  const day = `${TEST_MONTH}-06`;
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  reportBreakStart(yochi, at(day, "13:00"), seed("s18b", "יצאתי להפסקה"));
  // כרגע on_break, בלי break_end — "שכחתי לדווח שחזרתי"
  const r = requestAttendanceCorrection(yochi, {
    workDate: day,
    field: "break_end",
    newReportedForAtUtcIso: at(day, "13:10").toUTC().toISO()!,
    messageSeed: seed("s18b", "שכחתי לדווח שחזרתי מההפסקה, חזרתי ב-13:10"),
  });
  check("18b. השלמת break_end שנשכח — applied אוטומטית", r.ok && r.correction?.status === "applied", JSON.stringify(r));
  check("18b2. אין target_event_id (זו תוספת, לא תיקון ערך)", r.correction?.targetEventId == null);
  check("18b3. break_end נכתב כאירוע רגיל (לא event_type='correction')", listEventsForDay(yochi.key, day).some((e) => e.eventType === "break_end"));
  const afterComplete = await import("../src/ops/attendance.js").then((m) => m.reportDayClose(yochi, at(day, "17:00"), seed("s18b", "סיימתי")));
  check("18b4. אחרי ההשלמה היום נסגר כרגיל (10 דק' הפסקה)", afterComplete.ok && afterComplete.message.includes("10 דקות"), afterComplete.message);
}

// "אתמול סיימתי בארבע" — השלמת day_close שנשכח ליום שנשאר open/pending_completion
{
  const dayA = `${TEST_MONTH}-07`;
  const dayB = `${TEST_MONTH}-08`;
  checkAttendanceDayStart(yochi, at(dayA, "09:00")); // נשאר פתוח
  checkAttendanceDayStart(yochi, at(dayB, "08:30")); // יום חדש — dayA מסומן pending_completion

  const r = requestAttendanceCorrection(yochi, {
    workDate: dayA,
    field: "day_close",
    newReportedForAtUtcIso: at(dayA, "16:00").toUTC().toISO()!,
    messageSeed: seed("s18c", "אתמול סיימתי בארבע"),
  });
  check("18c. השלמת day_close ל'אתמול' הצליחה", r.ok && r.correction?.status === "applied", JSON.stringify(r));
  const dayARow = getDay(yochi.key, dayA);
  check("18c2. היום הקודם עכשיו closed עם נטו תקין (09:00-16:00=420)", dayARow?.status === "closed" && dayARow?.netMinutes === 420, JSON.stringify(dayARow));
  reportDayClose(yochi, at(dayB, "16:00"), seed("s18c2", "סיימתי"));
}

// תיקוף רצף: תיקון שהיה יוצר חפיפה/רצף הפוך — נדחה, שום דבר לא נכתב
{
  const day = `${TEST_MONTH}-09`;
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  reportBreakStart(yochi, at(day, "12:00"), seed("s18d", "יצאתי"));
  reportBreakEnd(yochi, at(day, "12:30"), seed("s18d", "חזרתי"));
  reportDayClose(yochi, at(day, "16:00"), seed("s18d", "סיימתי"));

  const correctionsBefore = listCorrectionsForUser(yochi.key).length;
  // מבקש לתקן את break_end ל-11:50 — *לפני* break_start (12:00) בזמן → רצף הפוך
  const target = listEventsForDay(yochi.key, day).find((e) => e.eventType === "break_end")!;
  const r = requestAttendanceCorrection(yochi, {
    workDate: day,
    field: "break_end",
    newReportedForAtUtcIso: at(day, "11:50").toUTC().toISO()!,
    messageSeed: seed("s18e", "תקן את החזרה"),
  });
  check("תיקוף רצף: תיקון שיוצר רצף הפוך נדחה מראש", !r.ok, r.message);
  check("תיקוף רצף: לא נוצרה שום בקשת תיקון (כשל לפני כתיבה)", listCorrectionsForUser(yochi.key).length === correctionsBefore);
  check("תיקוף רצף: האירוע המקורי (target) לא נגוע", target.reportedForAt === at(day, "12:30").toUTC().toISO());
}

// "ביום חמישי יצאתי בשעה שלוש וחצי" — חודש שכר *סגור*, ממתין לאישור מוטי, ואז מוכרע
{
  const day = `${TEST_MONTH}-10`;
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  reportDayClose(yochi, at(day, "17:00"), seed("s18f", "סיימתי"));
  closePayrollMonth(TEST_MONTH, "moti");

  const r = requestAttendanceCorrection(yochi, {
    workDate: day,
    field: "break_start",
    newReportedForAtUtcIso: at(day, "15:30").toUTC().toISO()!,
    messageSeed: seed("s18f", "ביום הזה יצאתי בשעה שלוש וחצי"),
  });
  check("18f. תיקון בחודש סגור — pending_approval, לא applied", r.ok && r.correction?.status === "pending_approval", JSON.stringify(r));
  check("18f2. עדיין אין break_start בפועל (לא הוחל)", !listEventsForDay(yochi.key, day).some((e) => e.eventType === "break_start"));

  const notManager = decideAttendanceCorrection(dov, r.correction!.id, true);
  check("18f3. דוב (לא מוטי) לא יכול להכריע", !notManager.ok, notManager.message);

  const decided = decideAttendanceCorrection(moti, r.correction!.id, true);
  check("18f4. מוטי מאשר — מוחל בפועל", decided.ok, decided.message);
  check("18f5. break_start נכתב כאירוע רגיל אחרי האישור", listEventsForDay(yochi.key, day).some((e) => e.eventType === "break_start"));

  const decidedTwice = decideAttendanceCorrection(moti, r.correction!.id, true);
  check("18f6. הכרעה כפולה (מירוץ/double-click) נדחית — CAS", !decidedTwice.ok, decidedTwice.message);
  check("18f7. עדיין רק אירוע break_start אחד (לא נכתב פעמיים מהמירוץ)", listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_start").length === 1);

  reopenPayrollMonth(TEST_MONTH, "moti");
}

// ── 19: בידוד נתונים בין עובדים ──────────────────────────────────────────────────
{
  const day = "2030-03-25";
  checkAttendanceDayStart(yochi, at(day, "09:00"));
  checkAttendanceDayStart(dov, at(day, "09:00"));
  reportBreakStart(dov, at(day, "12:00"), seed("s19", "דוב יצא"));
  const r = reportBreakEnd(yochi, at(day, "12:10"), seed("s19", "יוכי חוזר"));
  check("19a. מצב של דוב לא 'דולף' ליוכי", !r.ok, r.message);
  reportBreakEnd(dov, at(day, "12:20"), seed("s19", "דוב חוזר"));
  check("19b. יוכי: 0 מקטעי הפסקה", getDay(yochi.key, day)?.breakMinutes === 0);
  check("19c. דוב: מקטע הפסקה אחד נרשם (20 דק')", getDay(dov.key, day)?.breakMinutes === 20);
  reportDayClose(yochi, at(day, "16:00"), seed("s19", "יוכי מסיים"));
  reportDayClose(dov, at(day, "16:00"), seed("s19", "דוב מסיים"));
}

cleanup();

if (failed > 0) {
  logger.error(`${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("כל הבדיקות עברו ✅");
