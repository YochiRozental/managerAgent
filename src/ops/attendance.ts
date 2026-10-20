/**
 * מודול נוכחות — שכבת התאום: Day-Start Gate, פעולות העובד (יציאה/חזרה/סיום יום/תזכורת/תיקון),
 * ושער ההפעלה (Feature Flag + pilot allowlist + הרשאה). כל הלוגיקה העסקית הטהורה גרה ב-
 * attendanceEngine.ts; הקובץ הזה הוא ה-IO (DB) שעוטף אותה.
 *
 * כבוי כברירת מחדל (ATTENDANCE_MODULE_ENABLED=false) — ר' .env.example. גם כשמופעל, רק מי
 * שמופיע ב-ATTENDANCE_PILOT_USER_KEYS *וגם* יש לו report:hours רואה את הכלים (attendanceEnabledForUser).
 *
 * Monday: **אין כתיבה ל-Monday בקובץ הזה** — שלב ד בתכנון (ממתין לאישור מבנה העמודות). שדות
 * ה-sync ב-attendance_days קיימים ומוכנים (monday_sync_status/monday_sync_ref) אבל לא נכתבים
 * כאן לשום דבר מעבר ל"not_synced".
 *
 * Idempotency (audit שלב ג, 2026-10-11): כל כתיבה שמקורה בפעולת/הודעת משתמש מקבלת messageSeed —
 * מזהה יציב לאותה הודעה בדיוק (buildMessageIdempotencySeed, attendanceEngine.ts), **לא** דלי-זמן.
 * שני מקטעים לגיטימיים שונים באותה דקה בפועל מקבלים מפתחות שונים (ה-history שהם נולדו ממנו שונה);
 * retry/resend של אותה הודעה בדיוק מקבל את אותו מפתח ולא יוצר כפילות. כל רצף כתיבה (בדיקת מצב →
 * כתיבת אירוע → recompute) עטוף ב-runInTransaction (db.ts) — כשל באמצע מתבטל במלואו, לא משאיר
 * מצב חצי-עקבי.
 */

import { DateTime } from "luxon";
import { env, attendancePilotUserKeys } from "../config/env.js";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import { runInTransaction } from "../db/db.js";
import {
  checkTransition,
  computeDaySummary,
  computeLiveDaySummary,
  statusAfter,
  validateEventSequence,
  applyCorrections,
  buildEventIdempotencyKey,
  workDateFor,
  payrollMonthFor,
  formatMinutes,
  type AttendanceEventType,
  type AttendanceEventLike,
  type AttendanceStatus,
} from "./attendanceEngine.js";
import {
  getDay,
  upsertDay,
  findOpenDayBefore,
  markPendingCompletion,
  markNeedsMondaySync,
  findWorkDateForReminder,
  type StoredAttendanceDay,
} from "../db/repositories/attendanceDays.js";
import {
  insertEvent,
  listEventsForDay,
  listCorrectionsForDay,
  getEvent,
  getEventByIdempotencyKey,
  type EventSource,
} from "../db/repositories/attendanceEvents.js";
import { getReminderPref, markReminderAsked, setReminderTime as persistReminderTime } from "../db/repositories/attendanceReminderPrefs.js";
import {
  createCorrectionRequest,
  decideCorrection,
  attachAppliedEvent,
  getCorrection,
  getCorrectionByIdempotencyKey,
  type StoredCorrection,
} from "../db/repositories/attendanceCorrections.js";
import { isPayrollMonthClosed } from "../db/repositories/payrollMonths.js";
import { listUnseenNotifications, markNotificationSeenById } from "../db/repositories/notifications.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// שער ההפעלה
// ─────────────────────────────────────────────────────────────────────────────

export function isAttendanceModuleEnabled(): boolean {
  return env.ATTENDANCE_MODULE_ENABLED;
}

export function isAttendancePilotUser(userKey: string): boolean {
  return attendancePilotUserKeys.includes(userKey);
}

/** true ⇔ הדגל מופעל, המשתמש ברשימת הפיילוט, ויש לו הרשאת report:hours — כל שלושה, לא רק אחד. */
export function attendanceEnabledForUser(user: IdentifiedUser): boolean {
  return isAttendanceModuleEnabled() && isAttendancePilotUser(user.key) && userCan(user, "report:hours");
}

// ─────────────────────────────────────────────────────────────────────────────
// קריאה בלבד — attendance_day_status (audit שלב ז, 2026-10-13: הסוכן לא ידע להציג את אירועי
// היום בכלל — זה הכלי שסוגר את הפער).
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendanceDayStatusEvent {
  id: number;
  eventType: AttendanceEventType;
  /** HH:mm:ss, env.TIMEZONE — הערך *האפקטיבי* (אחרי תיקון, אם היה). */
  localTime: string;
  source: EventSource;
  /** true ⇔ תיקון קיים שינה את reportedForAt של האירוע הזה — localTime כבר משקף את הערך המתוקן. */
  wasCorrected: boolean;
}

export interface AttendanceDayStatusResult {
  workDate: string;
  /** סדר כרונולוגי (לפי הזמן האפקטיבי, אחרי תיקונים) — לא סדר-כתיבה. */
  events: AttendanceDayStatusEvent[];
  status: AttendanceStatus | "pending_completion";
  /** שעות נטו עד עכשיו — ר' isFinal. */
  netMinutesSoFar: number;
  breakMinutesSoFar: number;
  /** true ⇔ status==="closed": netMinutesSoFar/breakMinutesSoFar סופיים. false ⇔ עדיין הערכה
   *  זמנית (היום פתוח/בהפסקה) — להבחין במפורש בתשובה למשתמש, לא להציג כ"שעות מאושרות". */
  isFinal: boolean;
  asOfLocal: string;
}

/**
 * קריאה בלבד — לכלי attendance_day_status (agentTools.ts). ההרשאה/פיילוט נאכפים ב-AgentTool
 * (assertAttendanceEnabled, injectable, בדיוק כמו שאר 5 כלי הנוכחות) — לא כפול כאן, עקבי עם שאר
 * פונקציות הכתיבה בקובץ הזה (reportBreakStart וכו') שגם הן לא בודקות את הדגל ישירות, רק ה-AgentTool.
 * userKey נלקח תמיד מ-user.key (אין פרמטר "עבור מי" חוץ) — מבנית אי אפשר לבקש נתוני עובד אחר.
 */
export function getAttendanceDayStatus(
  user: IdentifiedUser,
  workDate: string,
  now: DateTime = DateTime.now().setZone(env.TIMEZONE),
): AttendanceDayStatusResult {
  const rawEvents = listEventsForDay(user.key, workDate).filter((e) => e.eventType !== "correction");
  const overlay = existingCorrectionOverlay(user.key, workDate);
  const overlayMap = new Map(overlay.map((o) => [o.correctsEventId, o.reportedForAt]));
  const effective = applyCorrections(rawEvents.map(toEventLike), overlay);

  const events: AttendanceDayStatusEvent[] = rawEvents
    .map((e) => ({
      id: e.id,
      eventType: e.eventType as AttendanceEventType,
      effectiveUtc: overlayMap.get(e.id) ?? e.reportedForAt,
      source: e.source,
      wasCorrected: overlayMap.has(e.id),
    }))
    .sort((a, b) => DateTime.fromISO(a.effectiveUtc).toMillis() - DateTime.fromISO(b.effectiveUtc).toMillis())
    .map((e) => ({
      id: e.id,
      eventType: e.eventType,
      localTime: DateTime.fromISO(e.effectiveUtc).setZone(env.TIMEZONE).toFormat("HH:mm:ss"),
      source: e.source,
      wasCorrected: e.wasCorrected,
    }));

  const day = getDay(user.key, workDate);
  const status: AttendanceStatus | "pending_completion" = day?.status === "pending_completion" ? "pending_completion" : statusAfter(effective);
  const live = computeLiveDaySummary(effective, now.toUTC().toISO()!);

  return {
    workDate,
    events,
    status,
    netMinutesSoFar: live.netMinutesSoFar,
    breakMinutesSoFar: live.breakMinutesSoFar,
    isFinal: live.status === "closed",
    asOfLocal: now.toFormat("HH:mm:ss"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// שחזור/חישוב מחדש — תמיד המקור היחיד לעדכון attendance_days, אחרי כל כתיבה ל-attendance_events.
// ─────────────────────────────────────────────────────────────────────────────

function toEventLike(e: { id: number; eventType: string; reportedForAt: string; sequenceNo: number }): AttendanceEventLike {
  return { id: e.id, eventType: e.eventType as AttendanceEventType, reportedForAt: e.reportedForAt, sequenceNo: e.sequenceNo };
}

/** overlay התיקונים הקיימים (שהוחלו בעבר) ל-work_date נתון — לא כולל תיקון מדומה/מוצע. */
function existingCorrectionOverlay(userKey: string, workDate: string) {
  return listCorrectionsForDay(userKey, workDate)
    .filter((c) => c.correctsEventId != null)
    .map((c) => ({ correctsEventId: c.correctsEventId!, reportedForAt: c.reportedForAt }));
}

/**
 * מחשבת את תמונת היום המלאה (status עדין — closed/working/on_break) מחדש מהיומן + תיקונים.
 * **לא** כותבת ל-DB — זו הפונקציה היחידה שגם applyEvent (לצורך checkTransition, שצריך את ה-status
 * העדין) וגם recomputeAndPersistDay (לצורך persist) קוראים לה, כדי ששתיהן לעולם לא יסטו זו מזו.
 */
function effectiveSummary(userKey: string, workDate: string) {
  const rawEvents = listEventsForDay(userKey, workDate).filter((e) => e.eventType !== "correction");
  const effective = applyCorrections(rawEvents.map(toEventLike), existingCorrectionOverlay(userKey, workDate));
  return computeDaySummary(effective);
}

/**
 * attendance_days.status הוא **גס** (open/closed/pending_completion — ר' schema.sql, ועל זה
 * מבוססות כל שאילתות ה-SQL כמו listOpenDaysDueForReminder/findOpenDayBefore). ה-status העדין
 * שה-state machine עובד איתו (working/on_break) ממופה כאן ל-"open" — ההבדל בין "עובד" ל"בהפסקה"
 * לא נשמר ברמת ה-cache הזה, רק נגזר-מחדש מהיומן בכל פעם שצריך (effectiveSummary, לא כאן).
 */
/**
 * סוגר (markNotificationSeenById) כל התראת attendance_reminder פתוחה של המשתמש ששייכת בוודאות
 * ליום-העבודה הזה — audit "מחזור חיים של התראות נוכחות" (2026-10-19): עד כה שום דבר לא חיבר בין
 * סגירת/אימות יום נוכחות לבין ההתראה שהזכירה אותו, אז תזכורת נשארה "פעילה" לנצח גם אחרי שהיום
 * נסגר בפועל — התראה 286 (13/10, יוכי) הייתה הדוגמה המדויקת לזה.
 *
 * שיוך "ודאי" בלבד: context.workDate (התראות חדשות) או findWorkDateForReminder — התאמה מדויקת
 * ל-reminder_sent_at (התראות ישנות). בלי שיוך ודאי — מדלגים על ההתראה הזו, לא מנחשים ולא סוגרים
 * (דרישה מפורשת: עדיף להשאיר פתוח מאשר לסגור בטעות). קוראים ל-markNotificationSeenById, לא ל-
 * UPDATE ישיר — כך הפעולה נשארת תחת אותה הגנת בעלות (user_key) ואותו SPECIAL_KINDS exclusion
 * כמו כל סימון-נקרא אחר; idempotent מאליו (שורה שכבר seen_at מדולגת בשקט).
 *
 * שני קוראים בלבד, שניהם מאמתים מצב נוכחות *אמיתי* לפני הקריאה — **לא** נקרא משום claim חופשי
 * בצ'אט: (1) recomputeAndPersistDay, כש-יום נסגר/נרשם-מחדש כסגור על ידי אירוע אמיתי (report
 * DayClose/תיקון); (2) agentTools.ts's attendance_day_status, כש-הסוכן רק *בודק* יום (קריאה
 * בלבד מבחינת נתוני נוכחות עצמם) ומגלה שהוא כבר סגור — גם בלי אירוע חדש באותו תור.
 */
export function closeAttendanceReminderNotifications(userKey: string, workDate: string): number {
  const candidates = listUnseenNotifications(userKey).filter((n) => n.kind === "attendance_reminder");
  let closed = 0;
  for (const n of candidates) {
    const storedWorkDate = typeof n.context?.workDate === "string" ? (n.context.workDate as string) : null;
    const resolvedWorkDate = storedWorkDate ?? findWorkDateForReminder(n.userKey, n.createdAt);
    if (resolvedWorkDate === workDate && markNotificationSeenById(userKey, n.id)) closed++;
  }
  return closed;
}

function recomputeAndPersistDay(userKey: string, workDate: string): StoredAttendanceDay {
  const summary = effectiveSummary(userKey, workDate);
  const dayStatus = summary.status === "closed" ? "closed" : "open";

  const day = upsertDay({
    userKey,
    workDate,
    status: dayStatus,
    openedReportedAt: summary.firstInAt,
    closedReportedAt: summary.lastOutAt,
    netMinutes: summary.netMinutes,
    breakMinutes: summary.breakMinutes,
    segmentCount: summary.segmentCount,
  });

  // סנכרון Monday (שלב ד — החלטה 4: מבוסס DB משותף, לא תלוי בערוץ): כל פעם שהיום *נגמר* סגור —
  // כולל תיקון שמגיע אחרי שהיום כבר נסגר — מסמנים שצריך (ל-ריסנכרן. לא CAS: תמיד מאפס ל-not_synced
  // (אלא אם כבר שם), כדי שתיקון אחרי שליחה ל-Monday יידחף שוב. ימים פתוחים לא מסונכרנים כלל כרגע.
  if (dayStatus === "closed") {
    markNeedsMondaySync(userKey, workDate);
    // best-effort, מחוץ ל"חובה" של persist היום עצמו — כשל כאן (למשל שאילתת notifications נכשלת)
    // לא אמור אף פעם לבטל/לשבש את כתיבת הנוכחות שכבר הצליחה (ר' upsertDay למעלה).
    try {
      closeAttendanceReminderNotifications(userKey, workDate);
    } catch (err) {
      logger.error({ err, userKey, workDate }, "סגירת תזכורות נוכחות אחרי סגירת יום נכשלה — רישום הנוכחות עצמו נשאר תקין");
    }
  }

  return day;
}

// ─────────────────────────────────────────────────────────────────────────────
// Day-Start Gate — נקרא מ-ops/chat.ts לפני בניית ה-system prompt. DB בלבד, בלי AI, בלי Monday.
// ─────────────────────────────────────────────────────────────────────────────

export interface DayStartCheckResult {
  /** טקסט להוסיף לפני תשובת הסוכן, או null אם אין מה להגיד (היום כבר טופל). */
  banner: string | null;
}

function nowUtcIso(now: DateTime): string {
  return now.toUTC().toISO()!;
}

/**
 * ההודעה הראשונה של העובד ביום עבודה. אם אין רישום להיום — פותחת יום (event+day), מכינה בנר,
 * ושואלת שעת תזכורת בפעם הראשונה בלבד. אם יש יום קודם שנשאר פתוח — מסמנת pending_completion
 * ומוסיפה שורה מתאימה, **בלי** לצבור את שעותיו אוטומטית ליום החדש ובלי לעכב את פתיחת היום החדש.
 * אם כבר יש רישום להיום (open/closed) — no-op, מחזירה banner=null. source: פרמטר לקראת חיבור
 * עתידי ל-WhatsApp (ר' §4 בדוח) — Web מעביר "chat_window", לא נדרש שינוי בחלונית עצמה.
 */
export function checkAttendanceDayStart(user: IdentifiedUser, now: DateTime, source: EventSource = "chat_window"): DayStartCheckResult {
  const workDate = workDateFor(now);
  const today = getDay(user.key, workDate);
  if (today) return { banner: null };

  return runInTransaction(() => {
    const stale = findOpenDayBefore(user.key, workDate);
    let staleNote = "";
    if (stale) {
      markPendingCompletion(user.key, stale.workDate);
      staleNote = `\n\n⚠️ שמתי לב שהנוכחות שלך מ-${stale.workDate} נשארה פתוחה — לא סגרת את היום ההוא. נשלים אותו בנפרד; זה לא משפיע על היום החדש שמתחיל עכשיו.`;
    }

    const reportedForAt = nowUtcIso(now);
    insertEvent({
      userKey: user.key,
      workDate,
      eventType: "day_open",
      reportedForAt,
      source,
      idempotencyKey: buildEventIdempotencyKey(user.key, "day_open", workDate, ""),
    });
    recomputeAndPersistDay(user.key, workDate);

    const pref = getReminderPref(user.key);
    let reminderQuestion = "";
    if (!pref) {
      markReminderAsked(user.key);
      reminderQuestion = "\nבאיזו שעה תרצה שאזכיר לך לסיים את הדיווח בכל יום?";
    }

    const banner =
      `בוקר טוב! התחלתי לרשום את שעות העבודה שלך מעכשיו, בשעה ${now.toFormat("HH:mm")}.\n` +
      `כשתסיים לעבוד, תעדכן אותי כדי שאוכל לסגור את הנוכחות שלך.${reminderQuestion}${staleNote}`;

    return { banner };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// פעולות העובד — יציאה זמנית / חזרה / סיום יום. כל אחת: checkTransition → insertEvent → recompute,
// כתיבה עטופה ב-runInTransaction.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendanceActionResult {
  ok: boolean;
  message: string;
  day?: StoredAttendanceDay;
}

function applyEvent(
  user: IdentifiedUser,
  now: DateTime,
  eventType: AttendanceEventType,
  messageSeed: string,
  source: EventSource,
): AttendanceActionResult | StoredAttendanceDay {
  const workDate = workDateFor(now);
  const idempotencyKey = buildEventIdempotencyKey(user.key, eventType, workDate, messageSeed);

  // retry/resend של *אותה* הודעה בדיוק — חובה לבדוק את זה *לפני* checkTransition: הריצה הראשונה
  // של ההודעה הזו כבר שינתה את ה-state (למשל working→on_break); אם הניסיון השני היה בודק
  // checkTransition על ה-state החדש, הוא היה נכשל בטעות ("אתה כבר בהפסקה") — אף שזו בדיוק אותה
  // פעולה שכבר הצליחה, לא פעולה שנייה סותרת. מחזירים את המצב הנוכחי (idempotent), בלי לבדוק FSM.
  if (getEventByIdempotencyKey(idempotencyKey)) return recomputeAndPersistDay(user.key, workDate);

  // ה-status העדין (working/on_break/closed) — תמיד נגזר מחדש מהיומן של *אותו* work_date, לא
  // מ-attendance_days.status (שהוא גס, ר' recomputeAndPersistDay). pending_completion רלוונטי רק
  // לימים *ישנים* (ר' checkAttendanceDayStart) — applyEvent פועל תמיד על workDateFor(now).
  const currentStatus = effectiveSummary(user.key, workDate).status;
  const check = checkTransition(currentStatus, eventType);
  if (!check.ok) return { ok: false, message: check.error! };

  return runInTransaction(() => {
    const reportedForAt = nowUtcIso(now);
    insertEvent({ userKey: user.key, workDate, eventType, reportedForAt, source, idempotencyKey });
    return recomputeAndPersistDay(user.key, workDate);
  });
}

export function reportBreakStart(user: IdentifiedUser, now: DateTime, messageSeed: string, source: EventSource = "chat_window"): AttendanceActionResult {
  const r = applyEvent(user, now, "break_start", messageSeed, source);
  if ("ok" in r) return r;
  return { ok: true, message: `רשמתי — יצאת ב-${now.toFormat("HH:mm")}. תגיד לי כשתחזור.`, day: r };
}

export function reportBreakEnd(user: IdentifiedUser, now: DateTime, messageSeed: string, source: EventSource = "chat_window"): AttendanceActionResult {
  const r = applyEvent(user, now, "break_end", messageSeed, source);
  if ("ok" in r) return r;
  return { ok: true, message: `רשמתי — חזרת ב-${now.toFormat("HH:mm")}. בהצלחה בהמשך היום.`, day: r };
}

export function reportDayClose(user: IdentifiedUser, now: DateTime, messageSeed: string, source: EventSource = "chat_window"): AttendanceActionResult {
  const r = applyEvent(user, now, "day_close", messageSeed, source);
  if ("ok" in r) return r;
  const day = r;
  const message =
    `סיימתי את דיווח הנוכחות שלך להיום.\n` +
    `כניסה: ${day.openedReportedAt ? DateTime.fromISO(day.openedReportedAt).setZone(env.TIMEZONE).toFormat("HH:mm") : "—"}\n` +
    `סיום: ${day.closedReportedAt ? DateTime.fromISO(day.closedReportedAt).setZone(env.TIMEZONE).toFormat("HH:mm") : "—"}\n` +
    `הפסקות: ${day.breakMinutes} דקות\n` +
    `סה"כ עבודה נטו: ${formatMinutes(day.netMinutes ?? 0)}.`;
  return { ok: true, message, day };
}

// ─────────────────────────────────────────────────────────────────────────────
// תזכורת אישית
// ─────────────────────────────────────────────────────────────────────────────

export function setAttendanceReminderTime(user: IdentifiedUser, hour: number, minute: number): AttendanceActionResult {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { ok: false, message: "שעה לא תקינה — תן לי שעה בפורמט HH:MM (למשל 17:30)." };
  }
  persistReminderTime(user.key, hour, minute);
  return { ok: true, message: `קבעתי — אזכיר לך לסיים דיווח נוכחות בשעה ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} בכל יום, אם הנוכחות עדיין פתוחה.` };
}

// ─────────────────────────────────────────────────────────────────────────────
// תיקון/השלמה רטרואקטיבית בשיחה — "אתמול סיימתי בארבע" / "התחלתי היום בתשע ולא בעשר" /
// "שכחתי לדווח שחזרתי מההפסקה" / "ביום חמישי יצאתי בשעה שלוש וחצי".
//
// שני מקרים, אותה פעולה: אם יש אירוע קיים מאותו field ביום המבוקש — זו **תיקון ערך** (overlay,
// event_type='correction'). אם אין — זו **השלמת דיווח שנשכח** (אירוע רגיל חדש, source='correction',
// נכנס לרצף לפי reportedForAt כמו כל אירוע אחר). שתי הדרכים עוברות **תיקוף מלא של הרצף המדומה**
// (validateEventSequence, אחרי מיון לפי reportedForAt — ר' attendanceEngine.ts) *לפני* כל כתיבה —
// זה מה שמונע מקטעים חופפים/רצף הפוך/משך שלילי: כל אלה מתגלים כמעבר לא-חוקי ב-state machine.
//
// מדיניות (אושרה 2026-10-11): תיקון עצמי בחודש פתוח = applied אוטומטית; חודש סגור = pending_approval
// (ממתין להכרעת מוטי — decideAttendanceCorrection). תמיד נכתב ל-attendance_corrections (יומן
// ביקורת), ורק אם/כש-applied — גם אירוע ב-attendance_events (לעולם לא UPDATE על אירוע קיים).
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestCorrectionInput {
  workDate: string; // YYYY-MM-DD
  field: AttendanceEventType;
  newReportedForAtUtcIso: string;
  reason?: string;
  /** מזהה יציב לההודעה הזו (buildMessageIdempotencySeed) — מונע בקשת תיקון כפולה מ-retry. */
  messageSeed: string;
  /** תיקון מפורש של אירוע ספציפי (ר' attendance_day_status לקבלת מזהים) — עוקף את ההתאמה-לפי-type
   *  למטה. מאומת: שייך ל-user.key, ל-workDate, ומסוג field (אחרת נדחה עם שגיאה ברורה). */
  eventId?: number;
  /** השלמת דיווח חסר — מוסיף אירוע *חדש* גם כש-כבר קיים אירוע אחד+ מאותו סוג היום (למשל הפסקה
   *  שנייה באותו יום). בלי זה, candidates.length>1 נדחה (עמימות), ו-candidates.length===1 מתקן
   *  את הקיים — לא משנה, כדי לא לשבור את ברירת המחדל הקיימת (תיקון עצמי "רגיל"). */
  insertNew?: boolean;
}

export interface RequestCorrectionResult extends AttendanceActionResult {
  correction?: StoredCorrection;
}

/**
 * מחילה בפועל תיקון שכבר אושר (auto או ע"י מוטי). targetEventId==null → **תוספת**: אירוע רגיל
 * חדש (לא event_type='correction') בעל source='correction' — זה "דיווח שנשכח", לא "ערך שגוי".
 * אחרת → **תיקון ערך**: אירוע event_type='correction' שמצביע (corrects_event_id) על המקור, בלי
 * לשנות אותו. בשני המקרים idempotency_key = `correction:${id}` — קריאה חוזרת (approve כפול,
 * retry) לא כותבת אירוע שני.
 */
function applyApprovedCorrection(correction: StoredCorrection): number {
  const idempotencyKey = `correction:${correction.id}`;

  if (correction.targetEventId == null) {
    const { event } = insertEvent({
      userKey: correction.userKey,
      workDate: correction.workDate,
      eventType: correction.field,
      reportedForAt: correction.newValue,
      source: "correction",
      requestedBy: correction.requestedBy,
      note: correction.reason ?? undefined,
      idempotencyKey,
    });
    recomputeAndPersistDay(correction.userKey, correction.workDate);
    return event.id;
  }

  const target = getEvent(correction.targetEventId);
  if (!target) throw new Error("האירוע המקורי לתיקון לא נמצא.");
  const { event } = insertEvent({
    userKey: correction.userKey,
    workDate: correction.workDate,
    eventType: "correction",
    effectiveEventType: target.eventType as AttendanceEventType,
    correctsEventId: target.id,
    reportedForAt: correction.newValue,
    source: "correction",
    requestedBy: correction.requestedBy,
    note: correction.reason ?? undefined,
    idempotencyKey,
  });
  recomputeAndPersistDay(correction.userKey, correction.workDate);
  return event.id;
}

/** בונה את הרצף המדומה (אירועי היום הקיימים, עם overlay התיקונים שכבר הוחלו, בתוספת/בהחלפה של
 *  ההצעה הנוכחית) — לתיקוף *לפני* כתיבה. לא כותב שום דבר. */
function simulateCorrection(userKey: string, workDate: string, targetId: number | null, field: AttendanceEventType, newValue: string): AttendanceEventLike[] {
  const rawEvents = listEventsForDay(userKey, workDate).filter((e) => e.eventType !== "correction");
  const baseline = applyCorrections(rawEvents.map(toEventLike), existingCorrectionOverlay(userKey, workDate));

  if (targetId != null) {
    return baseline.map((e) => (e.id === targetId ? { ...e, reportedForAt: newValue } : e));
  }
  // תוספת — sequenceNo גבוה-מכל-הקיימים כ-placeholder; המיון האמיתי הוא לפי reportedForAt
  // (ר' attendanceEngine.ts), אז המיקום הסידורי הזה לא משפיע על התוצאה, רק על שקילות ב-tie.
  const maxSeq = baseline.reduce((m, e) => Math.max(m, e.sequenceNo), 0);
  return [...baseline, { eventType: field, reportedForAt: newValue, sequenceNo: maxSeq + 1 }];
}

export function requestAttendanceCorrection(user: IdentifiedUser, input: RequestCorrectionInput): RequestCorrectionResult {
  // audit שלב ז (2026-10-13): שלוש דרכים לקבוע את ה-target, לפי סדר-עדיפות מפורש — לא עוד ניחוש
  // "אם יש בדיוק אחד, תקן אותו" בלי קשר לכוונה האמיתית (זה הממצא המדויק מהתקלה ב-13/10: הפסקה
  // שנייה פתוחה "תיקנה" בטעות את ה-break_end הסגור של ההפסקה הראשונה).
  let target: ReturnType<typeof getEvent> = null;
  if (input.eventId != null) {
    const ev = getEvent(input.eventId);
    if (!ev || ev.userKey !== user.key || ev.workDate !== input.workDate) {
      return { ok: false, message: `לא מצאתי אירוע מספר ${input.eventId} ביום ${input.workDate} עבורך.` };
    }
    if (ev.eventType !== input.field) {
      return {
        ok: false,
        message: `אירוע ${input.eventId} הוא מסוג "${ev.eventType}", לא "${input.field}" — בדוק את מזהה האירוע (attendance_day_status).`,
      };
    }
    target = ev;
  } else if (!input.insertNew) {
    const candidates = listEventsForDay(user.key, input.workDate).filter((e) => e.eventType === input.field);
    if (candidates.length > 1) {
      return {
        ok: false,
        message: `יש כמה אירועי "${input.field}" ביום ${input.workDate} — ציין eventId (ר' attendance_day_status) או insertNew אם זו תוספת (למשל הפסקה נוספת), לא תיקון לאחת הקיימות.`,
      };
    }
    target = candidates[0] ?? null;
  }
  // input.insertNew && input.eventId==null → target נשאר null בכוונה: הוספת אירוע חדש, גם אם יש
  // כבר אירוע/ים מאותו סוג היום (למשל break_end שני לסגירת הפסקה שנייה).

  // audit שלב ז (2026-10-13) — retry-check *לפני* סימולציה/תיקוף, לא רק בתוך createCorrectionRequest:
  // ל-insertNew (תוספת), simulateCorrection מוסיף הצעה חדשה ליומן *הנוכחי* — ביומן שכבר כולל את
  // האירוע שניסיון קודם (אותה בקשה בדיוק) כתב בפועל, ההצעה הנוספת-מדומה מתנגשת עם האירוע האמיתי
  // (למשל שני break_end רצופים) ונדחית כ"רצף לא תקין" — גם כש-זו *אותה* בקשה בדיוק. בדיוק עיקרון
  // getEventByIdempotencyKey לפני checkTransition ב-applyEvent (audit שלב ג) — בודקים idempotency
  // לפני שמנסים לשחזר/לתקף מחדש, לא אחרי.
  const idempotencyKey = `${user.key}:correction-request:${input.field}:${input.workDate}:${input.messageSeed}`;
  const existingByKey = getCorrectionByIdempotencyKey(idempotencyKey);
  if (existingByKey) {
    if (existingByKey.status === "applied") return { ok: true, message: "התיקון הזה כבר נשמר ועודכן.", correction: existingByKey };
    if (existingByKey.status === "rejected") return { ok: true, message: "התיקון הזה נדחה.", correction: existingByKey };
    return { ok: true, message: "התיקון הזה ממתין לאישור מוטי.", correction: existingByKey };
  }

  const simulated = simulateCorrection(user.key, input.workDate, target?.id ?? null, input.field, input.newReportedForAtUtcIso);
  const validation = validateEventSequence(simulated);
  if (!validation.ok) {
    return { ok: false, message: `התיקון הזה ייצור רצף נוכחות לא תקין (${validation.error}) — לא ביצעתי אותו.` };
  }

  const payrollMonth = payrollMonthFor(input.workDate);
  const autoApproved = !isPayrollMonthClosed(payrollMonth);

  return runInTransaction(() => {
    const { correction, created } = createCorrectionRequest({
      userKey: user.key,
      requestedBy: user.key,
      workDate: input.workDate,
      targetEventId: target?.id ?? null,
      field: input.field,
      oldValue: target?.reportedForAt ?? null,
      newValue: input.newReportedForAtUtcIso,
      reason: input.reason ?? null,
      payrollMonth,
      autoApproved,
      idempotencyKey,
    });

    if (!created) {
      // retry של אותה הודעה בדיוק — לא מחילים שום דבר פעם שנייה, רק מדווחים את המצב הקיים.
      if (correction.status === "applied") return { ok: true, message: "התיקון הזה כבר נשמר ועודכן.", correction };
      if (correction.status === "rejected") return { ok: true, message: "התיקון הזה נדחה.", correction };
      return { ok: true, message: "התיקון הזה ממתין לאישור מוטי.", correction };
    }

    if (!autoApproved) {
      return { ok: true, message: "חודש השכר הזה כבר סגור — העברתי את בקשת התיקון למוטי לאישור. אעדכן אותך כשיוכרע.", correction };
    }

    const appliedEventId = applyApprovedCorrection(correction);
    attachAppliedEvent(correction.id, appliedEventId);
    return { ok: true, message: "התיקון נשמר ועודכן.", correction: { ...correction, appliedEventId } };
  });
}

export interface DecideCorrectionResult {
  ok: boolean;
  message: string;
}

class AlreadyDecidedError extends Error {}

/**
 * הכרעת מוטי על בקשת תיקון שממתינה (חודש סגור). **לא נקראת משום UI/כלי צ'אט בשלב הזה** — קיימת
 * ומוכנה (ולכן נבדקת), אך לא מופעלת: אין endpoint ואין כלי AI שמחבר אליה. ר' דוח המימוש §4/§5.
 * סדר טרנזקציוני: applyApprovedCorrection + decideCorrection(CAS) יחד ב-runInTransaction — אם
 * ה-CAS נכשל (מירוץ/כבר הוכרע), זורקים ומבטלים גם את כתיבת האירוע (idempotent אם כבר נכתב
 * בניסיון מקביל קודם — ר' applyApprovedCorrection's idempotency_key — כך שה-rollback כאן תמיד
 * "לא עושה נזק", גם אם במקרה לא היה בו בכלל מה לבטל).
 */
export function decideAttendanceCorrection(manager: IdentifiedUser, correctionId: number, approve: boolean): DecideCorrectionResult {
  if (!userCan(manager, "approve:sensitive")) {
    return { ok: false, message: "רק מוטי יכול להכריע בקשות תיקון נוכחות." };
  }
  const correction = getCorrection(correctionId);
  if (!correction) return { ok: false, message: "בקשת התיקון לא נמצאה." };
  if (correction.status !== "pending_approval") return { ok: false, message: "הבקשה הזו כבר הוכרעה." };

  if (!approve) {
    const rejected = decideCorrection(correctionId, "rejected", manager.key, null);
    return rejected ? { ok: true, message: "התיקון נדחה." } : { ok: false, message: "הבקשה הזו כבר הוכרעה." };
  }

  try {
    return runInTransaction(() => {
      const appliedEventId = applyApprovedCorrection(correction);
      const claimed = decideCorrection(correctionId, "applied", manager.key, appliedEventId);
      if (!claimed) throw new AlreadyDecidedError();
      return { ok: true, message: "התיקון אושר ועודכן." };
    });
  } catch (err) {
    if (err instanceof AlreadyDecidedError) return { ok: false, message: "הבקשה הזו כבר הוכרעה." };
    throw err;
  }
}
