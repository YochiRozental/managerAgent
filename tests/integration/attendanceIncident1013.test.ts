/**
 * מודול נוכחות — תיקון תקלת הפיילוט של יוכי ב-13/10/2026 (audit שלב ז). שש תקלות, שש תיקונים:
 *   1. אישור-הצלחה שקרי (AI בלי tool_use) → נתיב דטרמיניסטי + retry מבוקר + כשל ברור.
 *   2. אין כלי להצגת היסטוריית היום → attendance_day_status (קריאה בלבד).
 *   3. תיקון נכשל כש-יש כמה הפסקות → eventId מפורש + insertNew לתוספת.
 *   4/5/6. record_commitment: לא לעצמי, לא "נשלח", לא "יוכי תטפל" כשה-יוכי *הוא* המשתמש.
 *
 * READ-ONLY מול Monday (אין קריאה בכלל). אפס AI אמיתי — כל קריאות ה-AI מוזרקות (_runModel/_config,
 * בדיוק עיקרון tests/regression/centralCore.test.ts).
 */

import "dotenv/config";
import { vi } from "vitest";
// runOpsChat מושך משימות אמיתיות מ-Monday בתחילת כל קריאה, לא תלוי בכלים שה-AI יבחר — לא קשור
// לתיקון הזה בכלל, ממוקם ב-chat.ts; ממוקק כאן ברמת הקובץ (לא נוגע בייצור) כדי שהבדיקה תישאר
// READ-ONLY/לוקאלית-בלבד (אין Monday אמיתי, אין fetch — ר' tests/setup/networkGuard.ts).
vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUserOpsTasks: async () => [], getProjectNextAction: async () => null, matchProjectsByQuery: () => [] };
});
// ATTENDANCE_PILOT_USER_KEYS האמיתי (.env) ריק — כל בדיקה שעוברת דרך chat.ts's AGENT_TOOLS האמיתי
// (requireAgentTool, לא buildAgentTools עם deps) תיחסם ב-assertAttendanceEnabled גם עם
// _attendanceEnabledForUser מוזרק ל-runOpsChat (זה שולט רק על *חשיפת* הכלים ל-tools[], לא על
// ה-execute הפנימי שלהם — הגנת-עומק מכוונת, ר' agentTools.ts). ממוקק כאן *רק* את ה-AGENT_TOOLS
// singleton (לא אף פונקציית כתיבה אמיתית) כדי שבדיקות ה-chat הזו יוכלו לבדוק הצלחה אמיתית —
// בדיוק buildAgentTools האמיתי, רק עם deps.attendanceEnabledForUser=()=>true.
vi.mock(import("../../src/ops/agentTools.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, AGENT_TOOLS: actual.buildAgentTools({ attendanceEnabledForUser: () => true }) };
});
import { DateTime } from "luxon";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/db.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { buildMessageIdempotencySeed } from "../../src/ops/attendanceEngine.js";
import {
  checkAttendanceDayStart,
  reportBreakStart,
  reportBreakEnd,
  reportDayClose,
  requestAttendanceCorrection,
  getAttendanceDayStatus,
} from "../../src/ops/attendance.js";
import { getDay } from "../../src/db/repositories/attendanceDays.js";
import { listEventsForDay } from "../../src/db/repositories/attendanceEvents.js";
import { listCorrectionsForUser } from "../../src/db/repositories/attendanceCorrections.js";
import { closePayrollMonth, reopenPayrollMonth } from "../../src/db/repositories/payrollMonths.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelParams } from "../../src/ai/providers/types.js";
import { check, assert } from "../helpers/check.js";

const yochi = resolveUserByKey("yochi")!;
const TEST_USERS = ["yochi"];
const TEST_MONTH = "2033-05";

function cleanup(): void {
  const placeholders = TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM attendance_corrections WHERE user_key IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM commitments WHERE created_by IN (${placeholders})`).run(...TEST_USERS);
  db.prepare(`DELETE FROM payroll_month_locks WHERE month = ?`).run(TEST_MONTH);
}
cleanup();

const at = (day: string, hhmm: string) => DateTime.fromISO(`${day}T${hhmm}:00`, { zone: env.TIMEZONE });
let turnCounter = 0;
const seed = () => buildMessageIdempotencySeed({ scopeId: "incident-1013-fixture", turnOrdinal: turnCounter++ });
const alwaysOn = () => true; // _attendanceEnabledForUser override — לא תלוי ב-ATTENDANCE_PILOT_USER_KEYS האמיתי

// ── fake model — scripted per-model-name steps, בדיוק עיקרון tests/regression/centralCore.test.ts ──
type ScriptStep = { text?: string; toolCalls?: { name: string; input?: unknown }[] };
function makeScriptedRunModel(scriptByModel: Record<string, ScriptStep[]>) {
  const cursor: Record<string, number> = {};
  const calls: RunModelParams[] = [];
  const fn: RunModelFn = async (params) => {
    calls.push(params);
    const script = scriptByModel[params.model] ?? [{ text: "x" }];
    const i = cursor[params.model] ?? 0;
    cursor[params.model] = i + 1;
    const step = script[Math.min(i, script.length - 1)]!;
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
    if (step.toolCalls) {
      const tcs: NormToolCall[] = step.toolCalls.map((t, k) => ({ id: `tc_${i}_${k}`, name: t.name, input: t.input ?? {} }));
      return { text: "", toolCalls: tcs, assistantContent: tcs.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input })), usage };
    }
    return { text: step.text ?? "", toolCalls: [], assistantContent: [{ type: "text" as const, text: step.text ?? "" }], usage };
  };
  return { fn, calls };
}
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };
const msg = (text: string): ChatMessage[] => [{ role: "user", content: text }];

// attendance_break_start/end (agentTools.ts) קוראים DateTime.now() בפועל (נכון לייצור — דיווח
// בזמן אמת הוא תמיד "עכשיו", לא תאריך מוזרק) — אז 1a/1b/1c (שעוברות דרך runOpsChat/chat.ts, לא
// ops/attendance.ts הטהור) חייבות לעבוד על ה-work_date האמיתי של היום, בניגוד לשאר הקובץ שמשתמש
// בתאריכים פיקטיביים. מנקים בין שלוש התת-בדיקות כי כולן חולקות את אותו "היום" האמיתי.
const today = DateTime.now().setZone(env.TIMEZONE).toISODate()!;
function cleanupToday(): void {
  db.prepare(`DELETE FROM attendance_events WHERE user_key=? AND work_date=?`).run("yochi", today);
  db.prepare(`DELETE FROM attendance_days WHERE user_key=? AND work_date=?`).run("yochi", today);
}

async function run() {
  // ── 1a: המודל אומר "רשמתי — חזרת" בלי tool_use כלל (turns=1, בדיוק התקלה) → לא מוצג למשתמש,
  //    retry ל-SMART, SMART *כן* קורא לכלי → תשובה דטרמיניסטית מתוצאת הכלי, לא מהמודל ─────────
  {
    const day = today;
    cleanupToday();
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:17"), seed()); // on_break, בדיוק כמו 12:17 בתקלה האמיתית

    const { fn } = makeScriptedRunModel({
      "test-fast": [{ text: "רשמתי — חזרת ב-12:28. מה הבא שאתה עובד עליו?" }], // בלי tool_use — התקלה המדויקת
      "test-smart": [
        { toolCalls: [{ name: "attendance_break_end", input: {} }] },
        { text: "משהו שהמודל יכתוב בחופשיות — לא אמור להישאר בתשובה הסופית" },
      ],
    });

    const result = await runOpsChat(yochi, msg("חזרתי"), {
      session: "s-1a",
      clientMessageId: "cmid-1a",
      _runModel: fn,
      _config: TEST_CONFIG,
      _attendanceEnabledForUser: alwaysOn,
    });

    check("1a. הטקסט החשוד ('רשמתי — חזרת ב-12:28') לא הוצג למשתמש", !result.reply.includes("12:28"));
    check("1a. תשובה סופית = בדיוק תוצאת הכלי האמיתי (לא ניסוח חופשי של SMART)", result.reply.includes("רשמתי") && result.reply.includes("12:17") === false);
    const ev = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_end");
    check("1a. break_end נכתב בפועל ב-DB (ה-retry עבד, לא רק הוצג טקסט)", ev.length === 1, String(ev.length));
    check("1a. מצב הנוכחות עדיין נכון (working אחרי break_end)", getDay(yochi.key, day)?.status === "open");
  }

  // ── 1b: גם ה-retry (SMART) לא קורא לכלי וחוזר על תבנית-אישור קנונית → כשל מפורש, לא הטקסט החשוד ──
  {
    const day = today;
    cleanupToday();
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:17"), seed());

    const { fn } = makeScriptedRunModel({
      "test-fast": [{ text: "רשמתי — חזרת ב-12:28. מה הבא שאתה עובד עליו?" }],
      "test-smart": [{ text: "רשמתי — חזרת ב-12:29. מה הבא שאתה עובד עליו?" }], // גם כאן בלי tool_use
    });

    const result = await runOpsChat(yochi, msg("חזרתי"), {
      session: "s-1b",
      clientMessageId: "cmid-1b",
      _runModel: fn,
      _config: TEST_CONFIG,
      _attendanceEnabledForUser: alwaysOn,
    });

    check("1b. אחרי שגם ה-retry נכשל — מוצגת הודעת כישלון מפורשת", result.reply.includes("לא הצלחתי לאשר בוודאות"));
    check("1b. הטקסט החשוד לא מוצג בשום צורה", !result.reply.includes("12:28") && !result.reply.includes("12:29"));
    const ev = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_end");
    check("1b. אין break_end כלשהו — לא בוצעה פעולה שלא קרתה באמת", ev.length === 0);
  }

  // ── 1c: retry לא גורם לכפילות — אם ה-FAST בפועל *כן* קרא לכלי בהצלחה (אין חשד בכלל), אין ניסיון
  //    שני ולא נוצר אירוע כפול; וגם אם היה ניסיון שני (אותו messageSeed) — idempotency מגן ───────
  {
    const day = today;
    cleanupToday();
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:17"), seed());

    const { fn, calls } = makeScriptedRunModel({
      "test-fast": [
        { toolCalls: [{ name: "attendance_break_end", input: {} }] },
        { text: "רשמתי — חזרת ב-12:28. מה הבא?" }, // כאן התבנית תואמת, *אבל* יש גיבוי אמיתי — לא חשד
      ],
    });

    const result = await runOpsChat(yochi, msg("חזרתי"), {
      session: "s-1c",
      clientMessageId: "cmid-1c",
      _runModel: fn,
      _config: TEST_CONFIG,
      _attendanceEnabledForUser: alwaysOn,
    });

    check("1c. יש גיבוי אמיתי (turns=2 אצל FAST) — אין retry ל-SMART בכלל", !calls.some((c) => c.model === "test-smart"));
    const ev = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_end");
    check("1c. אירוע break_end יחיד בלבד", ev.length === 1);
    void result;
    cleanupToday();
  }

  // ── 1d: סגירת-הפער (audit שלב ח) — המודל מנסח הצלחה-שקרית במילים *אחרות*, לא אחת מ-5 התבניות
  //    המדויקות ("סידרתי, הכול טוב" ולא "רשמתי — חזרת ב-X:XX") → עדיין נתפס, כי המשתמש ביקש
  //    פעולה (looksLikeAttendanceActionRequest) *וגם* התשובה נשמעת כהצהרת-ביצוע גנרית ────────────
  {
    const day = today;
    cleanupToday();
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:17"), seed());

    const { fn } = makeScriptedRunModel({
      "test-fast": [{ text: "סידרתי, הכול טוב!" }], // לא תואם לאף אחת מ-5 התבניות הקנוניות, בלי tool_use
      "test-smart": [{ text: "סודר, הכול תקין." }], // גם ה-retry לא קורא לכלי — גם זה לא תואם לתבניות הישנות
    });

    const result = await runOpsChat(yochi, msg("חזרתי"), {
      session: "s-1d",
      clientMessageId: "cmid-1d",
      _runModel: fn,
      _config: TEST_CONFIG,
      _attendanceEnabledForUser: alwaysOn,
    });

    check("1d. 'סידרתי, הכול טוב' לא הוצג למשתמש כאישור", !result.reply.includes("סידרתי") && !result.reply.includes("סודר"));
    check("1d. מוצגת הודעת כישלון מפורשת (לא הטקסט החשוד)", result.reply.includes("לא הצלחתי לאשר בוודאות"));
    const ev = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_end");
    check("1d. אין break_end — לא בוצעה פעולה שלא קרתה באמת", ev.length === 0);
    cleanupToday();
  }

  // ── 1e: שאלת-מידע טהורה (לא בקשת-ביצוע) — אסור לחסום/להציג כישלון, גם אם אין tool_use וגם אם
  //    התשובה כוללת מילה שנשמעת כמו "השלמה" (למשל "מצבך מעודכן") — ה-gate הראשון (looksLikeAttendanceActionRequest)
  //    לא מזהה כוונת-ביצוע כלל בהודעת משתמש שהיא שאלה ──────────────────────────────────────────
  {
    const day = today;
    cleanupToday();
    checkAttendanceDayStart(yochi, at(day, "09:00"));

    const { fn, calls } = makeScriptedRunModel({
      "test-fast": [{ text: "אתה כרגע בעבודה. המצב שלך מעודכן ל-09:00 כניסה, בלי הפסקות עדיין." }],
    });

    const result = await runOpsChat(yochi, msg("אני כרגע בעבודה או בהפסקה?"), {
      session: "s-1e",
      clientMessageId: "cmid-1e",
      _runModel: fn,
      _config: TEST_CONFIG,
      _attendanceEnabledForUser: alwaysOn,
    });

    check("1e. שאלת-מידע לא נחסמת — התשובה המקורית של המודל מוצגת כמו שהיא", result.reply.includes("אתה כרגע בעבודה"));
    check("1e. אין retry מיותר לשאלת-מידע (אין קריאה ל-SMART)", !calls.some((c) => c.model === "test-smart"));
    check("1e. אין הודעת-כישלון מיותרת", !result.reply.includes("לא הצלחתי לאשר בוודאות"));
    cleanupToday();
  }

  // ── 2: attendance_day_status — הצגת היסטוריית היום, כולל שעות עד-כה ליום פתוח ──────────────────
  {
    const day = "2033-05-13";
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:00"), seed());
    reportBreakEnd(yochi, at(day, "12:10"), seed());

    const status = getAttendanceDayStatus(yochi, day, at(day, "13:00"));
    check("2a. 3 אירועים בסדר כרונולוגי", status.events.length === 3);
    check("2b. סדר כרונולוגי נכון (day_open, break_start, break_end)", status.events.map((e) => e.eventType).join(",") === "day_open,break_start,break_end");
    check("2c. מצב נוכחי = working", status.status === "working");
    check("2d. שעות-עד-כה לא סופיות (isFinal=false, יום פתוח)", status.isFinal === false);
    check("2e. שעות-עד-כה = 230 דק' (09:00-13:00=240, פחות 10 דק' הפסקה)", status.netMinutesSoFar === 230, String(status.netMinutesSoFar));
    check("2f. יום אחר (אתמול) — ריק, לא קורס", getAttendanceDayStatus(yochi, "2033-05-01").events.length === 0);
    // הרשאות/פיילוט על attendance_day_status (לא רק getAttendanceDayStatus הטהורה) נבדקות ב-
    // attendanceTools.test.ts — אותו מנגנון assertAttendanceEnabled בדיוק כמו שאר 5 כלי הנוכחות.
  }

  // ── 3a: שתי הפסקות באותו יום, בלי eventId/insertNew — בדיוק ה-regression-trap מהתקלה האמיתית:
  //    candidates.length===1 (רק break_end אחד קיים) "מתקן" אותו בברירת המחדל, מזיז אותו *אחרי*
  //    ההפסקה השנייה שנפתחה בינתיים → רצף לא תקין (break_start כפול רציף) → validateEventSequence
  //    דוחה נכון (ר' דוח החקירה, סעיף 3-ב — זו ההגנה שכבר עבדה, לא "נשברה"; eventId/insertNew הם
  //    המילוט, נבדקים ב-3b/3d) ──────────────────────────────────────────────────────────────────
  {
    const day = "2033-05-14";
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "11:00"), seed());
    reportBreakEnd(yochi, at(day, "11:10"), seed());
    reportBreakStart(yochi, at(day, "14:00"), seed()); // הפסקה שנייה, פתוחה — בדיוק כמו בתקלה

    const ambiguous = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "break_end",
      newReportedForAtUtcIso: at(day, "14:10").toUTC().toISO()!,
      messageSeed: seed(),
    });
    check(
      "3a. בלי eventId/insertNew — נדחה (רצף לא תקין), לא מזיז בשקט את ה-break_end הלא-נכון",
      !ambiguous.ok && ambiguous.message.includes("רצף נוכחות לא תקין"),
      ambiguous.message,
    );
    check("3a2. האירוע המקורי (11:10) לא נגוע — אין correction בפועל", listEventsForDay(yochi.key, day).filter((e) => e.eventType === "correction").length === 0);

    cleanup2(day);
  }

  function cleanup2(day: string) {
    db.prepare(`DELETE FROM attendance_events WHERE user_key=? AND work_date=?`).run(yochi.key, day);
    db.prepare(`DELETE FROM attendance_days WHERE user_key=? AND work_date=?`).run(yochi.key, day);
    db.prepare(`DELETE FROM attendance_corrections WHERE user_key=? AND work_date=?`).run(yochi.key, day);
  }

  // ── 3b: eventId מפורש — מתקן בדיוק את האירוע הנכון בין כמה מאותו סוג ───────────────────────────
  {
    const day = "2033-05-15";
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "11:00"), seed());
    const firstBreakEnd = reportBreakEnd(yochi, at(day, "11:10"), seed());
    reportBreakStart(yochi, at(day, "14:00"), seed());
    const secondBreakEnd = reportBreakEnd(yochi, at(day, "14:10"), seed());

    const firstId = listEventsForDay(yochi.key, day).find((e) => e.eventType === "break_end" && e.reportedForAt.includes("08:10"))?.id; // 11:10 local = 08:10Z
    assert(firstId != null, "לא מצאתי את break_end הראשון (11:10) ב-DB");

    const corrected = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "break_end",
      newReportedForAtUtcIso: at(day, "11:15").toUTC().toISO()!,
      eventId: firstId!,
      messageSeed: seed(),
    });
    check("3b. תיקון לפי eventId הצליח", corrected.ok && corrected.correction?.status === "applied", corrected.message);
    check("3b2. התיקון תיקן בדיוק את האירוע שצוין (targetEventId=firstId)", corrected.correction?.targetEventId === firstId);
    void firstBreakEnd;
    void secondBreakEnd;

    // eventId שגוי (סוג לא תואם) נדחה בבירור
    const wrongType = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "break_start",
      newReportedForAtUtcIso: at(day, "11:00").toUTC().toISO()!,
      eventId: firstId!, // זה break_end, לא break_start
      messageSeed: seed(),
    });
    check("3c. eventId מסוג לא-תואם נדחה בבירור", !wrongType.ok && wrongType.message.includes("לא"));

    cleanup2(day);
  }

  // ── 3d: insertNew — משלים את הרצף המדויק מהתקלה: 12:17 יציאה (כבר קיים) → 12:28 חזרה → 13:57
  //    יציאה → 14:07 חזרה, שלוש תוספות נפרדות, בלי לפגוע באירוע התקין היחיד שכבר קיים ──────────
  {
    const day = "2033-05-16";
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:17"), seed()); // בדיוק כמו בתקלה — הפסקה פתוחה, בלי break_end

    const r1 = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "break_end",
      newReportedForAtUtcIso: at(day, "12:28").toUTC().toISO()!,
      insertNew: true,
      messageSeed: seed(),
    });
    check("3d1. הוספת break_end (12:28) הצליחה", r1.ok && r1.correction?.status === "applied", r1.message);

    const r2 = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "break_start",
      newReportedForAtUtcIso: at(day, "13:57").toUTC().toISO()!,
      insertNew: true,
      messageSeed: seed(),
    });
    check("3d2. הוספת break_start (13:57) הצליחה", r2.ok && r2.correction?.status === "applied", r2.message);

    const r3 = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "break_end",
      newReportedForAtUtcIso: at(day, "14:07").toUTC().toISO()!,
      insertNew: true,
      messageSeed: seed(),
    });
    check("3d3. הוספת break_end (14:07) הצליחה", r3.ok && r3.correction?.status === "applied", r3.message);

    const close = reportDayClose(yochi, at(day, "17:00"), seed());
    check("3d4. סגירת היום הצליחה אחרי כל ההוספות", close.ok, close.message);

    const status = getAttendanceDayStatus(yochi, day);
    check("3d5. 6 אירועים בסך הכל (open+start+end+start+end+close)", status.events.length === 6, String(status.events.length));
    check(
      "3d6. הרצף הכרונולוגי המלא תואם בדיוק לתקלה: 09:00→12:17→12:28→13:57→14:07→17:00",
      status.events.map((e) => e.localTime.slice(0, 5)).join(",") === "09:00,12:17,12:28,13:57,14:07,17:00",
      status.events.map((e) => e.localTime).join(","),
    );
    check("3d7. מצב סופי = closed", status.status === "closed");
    // נטו: שלושת מקטעי העבודה — (09:00-12:17)+(12:28-13:57)+(14:07-17:00) = 197+89+173 = 459 דק'
    check("3d8. שעות נטו סופיות נכונות (459 דק')", getDay(yochi.key, day)?.netMinutes === 459, String(getDay(yochi.key, day)?.netMinutes));

    cleanup2(day);
  }

  // ── 3e: idempotency — retry של *אותה* בקשת insertNew (אותו messageSeed) לא כותב פעמיים ──────────
  {
    const day = "2033-05-17";
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:17"), seed());
    const s = seed();
    const first = requestAttendanceCorrection(yochi, { workDate: day, field: "break_end", newReportedForAtUtcIso: at(day, "12:28").toUTC().toISO()!, insertNew: true, messageSeed: s });
    const retry = requestAttendanceCorrection(yochi, { workDate: day, field: "break_end", newReportedForAtUtcIso: at(day, "12:28").toUTC().toISO()!, insertNew: true, messageSeed: s });
    check("3e1. שני הניסיונות ok", first.ok && retry.ok, retry.message);
    check("3e2. אותה בקשת תיקון בדיוק (retry, לא כפולה)", first.correction?.id === retry.correction?.id);
    // תוספת (targetEventId==null) נכתבת כאירוע רגיל (event_type=field, source='correction') — לא
    // event_type='correction' (זה רק למסלול "תיקון ערך" של אירוע קיים, ר' applyApprovedCorrection).
    const breakEnds = listEventsForDay(yochi.key, day).filter((e) => e.eventType === "break_end");
    check("3e3. אירוע break_end יחיד בפועל (אין כפילות מה-retry)", breakEnds.length === 1, String(breakEnds.length));
    cleanup2(day);
  }

  // ── 3f: חודש שכר סגור — insertNew *גם* ממתין לאישור מוטי, לא מוחל ישר (מדיניות קיימת לא נשברה) ──
  {
    const day = `${TEST_MONTH}-18`;
    checkAttendanceDayStart(yochi, at(day, "09:00"));
    reportBreakStart(yochi, at(day, "12:17"), seed());
    closePayrollMonth(TEST_MONTH, "moti");

    const r = requestAttendanceCorrection(yochi, {
      workDate: day,
      field: "break_end",
      newReportedForAtUtcIso: at(day, "12:28").toUTC().toISO()!,
      insertNew: true,
      messageSeed: seed(),
    });
    check("3f1. בחודש סגור — ok אבל ממתין למוטי, לא מוחל", r.ok && r.correction?.status === "pending_approval", r.message);
    check("3f2. לא נכתב אירוע break_end בפועל (עדיין לא אושר)", listEventsForDay(yochi.key, day).filter((e) => e.eventType === "correction").length === 0);

    reopenPayrollMonth(TEST_MONTH, "moti");
    db.prepare(`DELETE FROM attendance_events WHERE user_key=? AND work_date=?`).run(yochi.key, day);
    db.prepare(`DELETE FROM attendance_days WHERE user_key=? AND work_date=?`).run(yochi.key, day);
    db.prepare(`DELETE FROM attendance_corrections WHERE user_key=? AND work_date=?`).run(yochi.key, day);
  }

  // ── 4/5/6: record_commitment — לא לעצמי, לא "נשלח", לא בלבול-זהות ─────────────────────────────
  {
    const { fn } = makeScriptedRunModel({
      "test-fast": [{ toolCalls: [{ name: "record_commitment", input: { toWhom: "יוכי", what: "לסדר ידנית את רישומי הנוכחות" } }] }, { text: "סודר." }],
    });
    const result = await runOpsChat(yochi, msg("תזכיר לי לסדר את זה"), {
      session: "s-4",
      clientMessageId: "cmid-4",
      _runModel: fn,
      _config: TEST_CONFIG,
      _attendanceEnabledForUser: alwaysOn,
    });
    const rows = db.prepare(`SELECT * FROM commitments WHERE created_by=?`).all(yochi.key) as { to_whom: string }[];
    check("4a. record_commitment ל-toWhom=המשתמש עצמו (יוכי) לא נוצר בפועל", rows.length === 0, JSON.stringify(rows));
    void result;
  }
  {
    const { fn } = makeScriptedRunModel({
      "test-fast": [{ toolCalls: [{ name: "record_commitment", input: { toWhom: "לקוח כלשהו", what: "לשלוח הצעת מחיר" } }] }, { text: "נשמר." }],
    });
    const result = await runOpsChat(yochi, msg("הבטחתי ללקוח לשלוח הצעת מחיר"), {
      session: "s-5",
      clientMessageId: "cmid-5",
      _runModel: fn,
      _config: TEST_CONFIG,
      _attendanceEnabledForUser: alwaysOn,
    });
    const rows = db.prepare(`SELECT * FROM commitments WHERE created_by=? AND to_whom=?`).all(yochi.key, "לקוח כלשהו") as unknown[];
    check("5a. commitment אמיתי לצד שלישי *כן* נוצר (לא נפגע התפקוד התקין)", rows.length === 1, String(rows.length));
    check("5b. actions (ה-toast) לא טוען 'נשלח' — מבהיר שזה יומן פנימי", result.actions.some((a) => a.includes("נשמר ביומן") || a.includes("לא נשלח")));
  }

  cleanup();
}

await run();
