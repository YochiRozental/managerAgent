/**
 * מנוע נוכחות — לוגיקה טהורה בלבד (attendanceEngine.ts). בלי DB, בלי Monday.
 *   npm run test:attendance-engine
 */

import { logger } from "../src/utils/logger.js";
import {
  checkTransition,
  statusAfter,
  computeDaySummary,
  validateEventSequence,
  buildEventIdempotencyKey,
  buildMessageIdempotencySeed,
  applyCorrections,
  formatMinutes,
  payrollMonthFor,
  workDateFor,
  type AttendanceEventLike,
} from "../src/ops/attendanceEngine.js";
import { DateTime } from "luxon";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const d = "2026-10-11";
const t = (hhmm: string) => `${d}T${hhmm}:00.000Z`;
const ev = (eventType: AttendanceEventLike["eventType"], time: string, seq: number, id = seq): AttendanceEventLike => ({
  id,
  eventType,
  reportedForAt: t(time),
  sequenceNo: seq,
});

// 1. הודעה ראשונה פותחת נוכחות
{
  const r = checkTransition("closed", "day_open");
  check("1. day_open מ-closed → working", r.ok && r.nextStatus === "working");
}

// 2. הודעה שנייה (day_open) לא פותחת שוב
{
  const r = checkTransition("working", "day_open");
  check("2. day_open שני באותו יום נדחה", !r.ok, r.error);
}

// 3. יום סגור לא נפתח מחדש אוטומטית
{
  const r1 = checkTransition("closed", "break_start");
  const r2 = checkTransition("closed", "day_close");
  check("3a. break_start על יום סגור נדחה", !r1.ok);
  check("3b. day_close על יום סגור נדחה", !r2.ok);
}

// 4. יציאה וחזרה אחת
{
  const events = [ev("day_open", "09:00", 1), ev("break_start", "12:30", 2), ev("break_end", "13:15", 3), ev("day_close", "16:00", 4)];
  const s = computeDaySummary(events);
  check("4a. מצב סופי closed", s.status === "closed");
  check("4b. נטו 6 שעות ו-15 דקות (375 דק')", s.netMinutes === 375, String(s.netMinutes));
  check("4c. הפסקה 45 דקות", s.breakMinutes === 45, String(s.breakMinutes));
  check("4d. 2 מקטעי עבודה", s.segmentCount === 2);
  check("4e. formatMinutes(375) === '6 שעות ו-15 דקות'", formatMinutes(375) === "6 שעות ו-15 דקות", formatMinutes(375));
}

// 5. מספר יציאות וחזרות (לא מוגבל)
{
  const events = [
    ev("day_open", "08:00", 1),
    ev("break_start", "10:00", 2),
    ev("break_end", "10:10", 3),
    ev("break_start", "12:00", 4),
    ev("break_end", "13:00", 5),
    ev("break_start", "15:00", 6),
    ev("break_end", "15:05", 7),
    ev("day_close", "17:00", 8),
  ];
  const s = computeDaySummary(events);
  check("5a. 4 מקטעי עבודה (3 הפסקות)", s.segmentCount === 4, String(s.segmentCount));
  check("5b. הפסקות: 10+60+5=75 דק'", s.breakMinutes === 75, String(s.breakMinutes));
  check("5c. נטו = 540-75=465 דק'", s.netMinutes === 465, String(s.netMinutes));
}

// 6. יציאה כפולה / 7. חזרה בלי יציאה / 8. סיום כפול
{
  check("6. break_start כפול נדחה", !checkTransition("on_break", "break_start").ok);
  check("7. break_end בלי break_start נדחה", !checkTransition("working", "break_end").ok);
  check("8. day_close כפול נדחה", !checkTransition("closed", "day_close").ok);
}

// 9. שכחה לסגור יום — אין auto-close; status נשאר open/on_break, netMinutes null (לא "מאושר")
{
  const events = [ev("day_open", "09:00", 1)];
  const s = computeDaySummary(events);
  check("9a. status נשאר working (לא closed מעצמו)", s.status === "working");
  check("9b. netMinutes null כל עוד לא closed", s.netMinutes === null);
}

// day_close מתוך on_break — סוגר את ההפסקה הפתוחה בלי להמציא עבודה
{
  const events = [ev("day_open", "09:00", 1), ev("break_start", "12:00", 2), ev("day_close", "12:30", 3)];
  const s = computeDaySummary(events);
  check("day_close מ-on_break: status closed", s.status === "closed");
  check("day_close מ-on_break: נטו = 09:00-12:00 בלבד (180 דק')", s.netMinutes === 180, String(s.netMinutes));
  check("day_close מ-on_break: הפסקה 30 דק' (12:00-12:30)", s.breakMinutes === 30, String(s.breakMinutes));
}

// ── מיון לפי reportedForAt, לא sequenceNo (audit שלב ג) — ו-tie-break ב-sequenceNo לזמנים זהים ──
{
  // sequenceNo הפוך לגמרי מ-reportedForAt — אם המנוע היה עדיין ממיין לפי sequenceNo, זה "יפוצץ".
  const events = [ev("day_close", "16:00", 1), ev("break_end", "13:15", 2), ev("break_start", "12:30", 3), ev("day_open", "09:00", 4)];
  const s = computeDaySummary(events);
  check("מיון לפי reportedForAt: סדר ארעי (sequenceNo) לא קובע את התוצאה", s.status === "closed" && s.netMinutes === 375, JSON.stringify(s));
}
{
  // שני אירועים עם reportedForAt זהה בדיוק — sequenceNo הוא ה-tie-breaker, לא קורס, לא מתפוצץ.
  const events = [ev("day_open", "09:00", 1), ev("break_start", "09:00", 2), ev("break_end", "09:00", 3)];
  const r = validateEventSequence(events);
  check("tie-break בזמן זהה: רצף תקין (day_open→break_start→break_end לפי sequenceNo)", r.ok, r.error);
}

// ── validateEventSequence — תיקוף מחמיר: מזהה רצף הפוך/חופף ומסרב (לא מדלג בשקט כמו computeDaySummary) ──
{
  const ok = validateEventSequence([ev("day_open", "09:00", 1), ev("break_start", "12:00", 2), ev("break_end", "12:30", 3), ev("day_close", "16:00", 4)]);
  check("validateEventSequence: רצף תקין → ok", ok.ok);

  // break_end לפני break_start בזמן (תיקון שהיה יוצר "משך שלילי"/רצף הפוך)
  const overlap = validateEventSequence([ev("day_open", "09:00", 1), ev("break_start", "12:00", 2), ev("break_end", "11:50", 3), ev("day_close", "16:00", 4)]);
  check("validateEventSequence: break_end לפני break_start בזמן → נדחה", !overlap.ok, overlap.error);

  // day_open שהוזז (ע"י תיקון) לאחרי break_start קיים — "מקטע חופף" במובן של רצף לא-אפשרי
  const movedOpen = validateEventSequence([ev("break_start", "08:00", 1), ev("day_open", "09:00", 2), ev("break_end", "10:00", 3)]);
  check("validateEventSequence: day_open אחרי break_start → נדחה (אין נוכחות פתוחה)", !movedOpen.ok, movedOpen.error);
}

// ── idempotency key — יציב להודעה, לא דלי-זמן (audit שלב ג: התיקון המרכזי) ──
{
  const k1 = buildEventIdempotencyKey("yochi", "day_open", d, "");
  const k2 = buildEventIdempotencyKey("yochi", "day_open", d, "any-seed-ignored");
  check("day_open: idempotency key תמיד יחיד פר-יום, לא תלוי ב-messageSeed", k1 === k2);

  // שכבה 1: channelMessageId — מועדף תמיד, לא תלוי בכלום אחר
  const cmidA = buildMessageIdempotencySeed({ channelMessageId: "wa-msg-123", scopeId: "jid-972501234567" });
  const cmidA2 = buildMessageIdempotencySeed({ channelMessageId: "wa-msg-123", scopeId: "jid-DIFFERENT" });
  check("channelMessageId: מועדף על scopeId — אותו מזהה ערוץ → אותו seed גם אם scopeId שונה", cmidA === cmidA2);
  const cmidB = buildMessageIdempotencySeed({ channelMessageId: "wa-msg-456", scopeId: "jid-972501234567" });
  check("channelMessageId: מזהה הודעה אחר → seed אחר", cmidA !== cmidB);

  // שכבה 2: turnOrdinal — ה-fallback. **התיקון המרכזי**: יציב גם אם history/תוכן ההודעה השתנו
  // בין ניסיון מקורי לחוזר — ה-seed תלוי רק ב-(scopeId, turnOrdinal), לא בשום תוכן שיחה.
  const seedA = buildMessageIdempotencySeed({ scopeId: "session-1", turnOrdinal: 3 });
  const seedA_retryWithDifferentHistoryContext = buildMessageIdempotencySeed({ scopeId: "session-1", turnOrdinal: 3 });
  check("turnOrdinal: אותו (scopeId,ordinal) → seed זהה בדיוק (retry, גם אם ה-history שהתקבל בבקשה השתנה)", seedA === seedA_retryWithDifferentHistoryContext);

  const seedNextTurn = buildMessageIdempotencySeed({ scopeId: "session-1", turnOrdinal: 4 }); // הודעה אמיתית הבאה — ordinal עלה
  check("turnOrdinal: הודעה חדשה אמיתית (ordinal גבוה יותר) → seed אחר", seedA !== seedNextTurn);

  const seedOtherSession = buildMessageIdempotencySeed({ scopeId: "session-2", turnOrdinal: 3 });
  check("turnOrdinal: אותו ordinal, שיחה אחרת → seed אחר (לא מתנגש בין שיחות)", seedA !== seedOtherSession);

  let threw = false;
  try {
    buildMessageIdempotencySeed({ scopeId: "session-1" }); // אין channelMessageId ואין turnOrdinal
  } catch {
    threw = true;
  }
  check("בלי channelMessageId ובלי turnOrdinal → זורק (שגיאת-תכנות, לא fallback חרישי)", threw);

  const kBreak1 = buildEventIdempotencyKey("yochi", "break_start", d, seedA);
  const kBreak2 = buildEventIdempotencyKey("yochi", "break_start", d, seedNextTurn); // "מקטע הפסקה שני" — seed אחר
  check("break_start: שני מקטעים אמיתיים (seed אחר) באותה דקה בפועל → מפתחות שונים", kBreak1 !== kBreak2);
  const kBreakRetry = buildEventIdempotencyKey("yochi", "break_start", d, seedA_retryWithDifferentHistoryContext);
  check("break_start: retry של אותה הודעה → אותו מפתח בדיוק", kBreak1 === kBreakRetry);
}

// תיקון — לא משנה היסטוריה, רק overlay בזמן קריאה
{
  const original = [ev("day_open", "09:00", 1, 101), ev("day_close", "16:00", 2, 102)];
  const corrected = applyCorrections(original, [{ correctsEventId: 101, reportedForAt: t("08:30") }]);
  check("applyCorrections: שעת הכניסה הוחלפה בעותק", corrected[0]!.reportedForAt === t("08:30"));
  check("applyCorrections: המקור לא נגוע (עותק חדש, לא mutation)", original[0]!.reportedForAt === t("09:00"));
  const s = computeDaySummary(corrected);
  check("applyCorrections: הנטו מחושב לפי הערך המתוקן (7.5 שעות = 450 דק')", s.netMinutes === 450, String(s.netMinutes));
}

// עזרי תאריך
{
  const now = DateTime.fromISO("2026-10-11T22:30:00", { zone: "Asia/Jerusalem" });
  check("workDateFor מחזיר YYYY-MM-DD מקומי", workDateFor(now) === "2026-10-11", workDateFor(now));
  check("payrollMonthFor חותך לחודש", payrollMonthFor("2026-10-11") === "2026-10");
}

// statusAfter — שחזור מלא מהיומן, מתעלם משגיאות היסטוריות בלי לקרוס
{
  const events = [ev("day_open", "09:00", 1), ev("break_start", "12:00", 2)];
  check("statusAfter: on_break", statusAfter(events) === "on_break");
  const withBogus = [...events, ev("day_open", "13:00", 3)]; // אירוע לא-חוקי בהיסטוריה
  check("statusAfter: מדלג על אירוע לא-חוקי בלי לקרוס", statusAfter(withBogus) === "on_break");
}

if (failed > 0) {
  logger.error(`${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("כל הבדיקות עברו ✅");
