/**
 * מנוע נוכחות — לוגיקה טהורה בלבד: state machine, חישוב שעות נטו, בניית מפתח idempotency, החלת
 * תיקונים בזמן קריאה, ותיקוף רצף מלא. בלי DB, בלי Monday, בלי import של אף אחד מהם — ניתן
 * לבדיקה ישירה (npm run test:attendance-engine), בדיוק כמו policy.ts/followups.ts.
 *
 * "תיקון לא משנה היסטוריה": attendance_events הוא append-only. applyCorrections (למטה) היא
 * טרנספורמציית-קריאה בלבד — מחליפה reportedForAt של אירוע מתוקן *בעותק* שמוזן לחישוב, לעולם לא
 * כותבת ל-DB וגם לא מקבלת/מחזירה רפרנס לשורת ה-DB המקורית.
 *
 * סדר עיבוד (תוקן, audit שלב ג — 2026-10-11): מיון לפי **reportedForAt**, לא לפי sequenceNo.
 * sequenceNo (סדר הגעה בפועל) משמש רק כ-tie-breaker לזמנים זהים. זה נכון גם לדיווח חי (אם הודעה
 * הגיעה מעט לא-לפי-הסדר, ה-reportedForAt עדיין משקף נכון מה קרה קודם) וגם לתיקונים רטרואקטיביים
 * (שם ההבדל בין "מתי זה נכתב ל-DB" ל"מתי זה *קרה*" יכול להיות ימים שלמים) — ור' validateEventSequence
 * למטה, שמשתמש בדיוק בסדר הזה כדי לסרב תיקון שהיה יוצר רצף לא-תקין (חפיפה/סדר הפוך).
 */

import { DateTime } from "luxon";

export type AttendanceStatus = "closed" | "working" | "on_break";
export type AttendanceEventType = "day_open" | "break_start" | "break_end" | "day_close";

export interface AttendanceEventLike {
  id?: number;
  eventType: AttendanceEventType;
  /** UTC ISO — השעה שעליה מדווחים (יכול להיות רטרואקטיבי). */
  reportedForAt: string;
  /** סדר הגעה בפועל — tie-breaker בלבד למיון (ר' docstring בראש הקובץ), לא מפתח המיון הראשי. */
  sequenceNo: number;
}

/**
 * טבלת המעברים החוקיים היחידה. day_close מ-on_break מותר בכוונה (החלטת תכנון שלב א, לא מחייבת
 * אישור נוסף): סוגר את ההפסקה הפתוחה באותו רגע — לא ממציא זמן עבודה, רק מפסיק לספור הפסקה משם.
 */
const VALID_TRANSITIONS: Record<AttendanceStatus, Partial<Record<AttendanceEventType, AttendanceStatus>>> = {
  closed: { day_open: "working" },
  working: { break_start: "on_break", day_close: "closed" },
  on_break: { break_end: "working", day_close: "closed" },
};

const REJECTION_MESSAGES: Record<AttendanceStatus, Partial<Record<AttendanceEventType, string>>> = {
  closed: {
    day_open: "הנוכחות שלך כבר פתוחה היום.",
    break_start: "אין נוכחות פתוחה היום — אין מה לדווח יציאה עליו.",
    break_end: "אין נוכחות פתוחה היום — אין מה לדווח חזרה עליו.",
    day_close: "אין נוכחות פתוחה היום — אין מה לסגור.",
  },
  working: {
    day_open: "הנוכחות שלך כבר פתוחה היום.",
    break_end: "לא דיווחת יציאה — אין ממה לחזור.",
  },
  on_break: {
    day_open: "הנוכחות שלך כבר פתוחה היום (ואתה כרגע בהפסקה).",
    break_start: "אתה כבר בהפסקה.",
  },
};

export interface TransitionCheck {
  ok: boolean;
  nextStatus: AttendanceStatus;
  error?: string;
}

/** הבדיקה היחידה לפני כל כתיבה — טהורה, לא תלויה ב-DB. */
export function checkTransition(current: AttendanceStatus, eventType: AttendanceEventType): TransitionCheck {
  const next = VALID_TRANSITIONS[current]?.[eventType];
  if (next) return { ok: true, nextStatus: next };
  return {
    ok: false,
    nextStatus: current,
    error: REJECTION_MESSAGES[current]?.[eventType] ?? "פעולה לא חוקית במצב הנוכחי של הנוכחות.",
  };
}

/** reportedForAt ראשי, sequenceNo כ-tie-breaker (ר' docstring בראש הקובץ). */
function sorted(events: readonly AttendanceEventLike[]): AttendanceEventLike[] {
  return [...events].sort((a, b) => {
    const t = DateTime.fromISO(a.reportedForAt).toMillis() - DateTime.fromISO(b.reportedForAt).toMillis();
    return t !== 0 ? t : a.sequenceNo - b.sequenceNo;
  });
}

/** המצב הנוכחי לפי שחזור מלא של היומן. אירוע לא-חוקי בהיסטוריה (לא אמור לקרות אחרי validateEventSequence,
 *  אבל נתוני עבר אמיתיים חייבים resilience) — מדלגים בשקט, לא זורקים. */
export function statusAfter(events: readonly AttendanceEventLike[]): AttendanceStatus {
  let status: AttendanceStatus = "closed";
  for (const e of sorted(events)) {
    const check = checkTransition(status, e.eventType);
    if (check.ok) status = check.nextStatus;
  }
  return status;
}

export interface ValidationResult {
  ok: boolean;
  /** האירוע (לפי אינדקס ברשימה הממוינת) שבו הרצף נכשל, אם נכשל. */
  error?: string;
}

/**
 * תיקוף **מחמיר** — בניגוד ל-computeDaySummary/statusAfter (שמדלגים על אירוע לא-תקין כדי לא
 * לקרוס על דאטה היסטורי), הפונקציה הזו נועדה לרוץ *לפני* כתיבה — על הרצף המלא **לאחר** תיקון
 * משוער (simulated) — ומחזירה שגיאה מפורשת ברגע הראשון שמשהו לא מסתדר. זו ה"מניעת מקטעים
 * חופפים/זמנים לא תקינים/משך עבודה שלילי" בפועל: כל אלה הם תוצאה אוטומטית של מעבר לא-חוקי
 * ב-state machine כשהרצף ממוין לפי reportedForAt (למשל break_end לפני break_start = "לא דיווחת
 * יציאה"; day_open שהוזז לאחרי break_start קיים = "אין נוכחות פתוחה היום").
 */
export function validateEventSequence(events: readonly AttendanceEventLike[]): ValidationResult {
  let status: AttendanceStatus = "closed";
  for (const e of sorted(events)) {
    const check = checkTransition(status, e.eventType);
    if (!check.ok) return { ok: false, error: check.error };
    status = check.nextStatus;
  }
  return { ok: true };
}

export interface AttendanceSegment {
  startAt: string;
  endAt: string | null;
}

export interface DaySummary {
  status: AttendanceStatus;
  /** מקטעי *עבודה* בלבד (הפסקות לא נכללות). */
  segments: AttendanceSegment[];
  /** null כל עוד status !== 'closed' — יום פתוח לעולם לא "שעות מאושרות". */
  netMinutes: number | null;
  breakMinutes: number;
  segmentCount: number;
  firstInAt: string | null;
  lastOutAt: string | null;
}

function minutesBetween(a: string, b: string): number {
  return DateTime.fromISO(b).diff(DateTime.fromISO(a)).as("minutes");
}

/**
 * מחשבת את תמונת היום המלאה מתוך יומן האירועים (אחרי applyCorrections אם רלוונטי). טהורה,
 * דטרמיניסטית — אותו קלט מניב אותה תוצאה תמיד. ממיינת לפי reportedForAt (ר' docstring בראש
 * הקובץ) — לא מניחה שהיומן מגיע מסודר.
 */
export function computeDaySummary(events: readonly AttendanceEventLike[]): DaySummary {
  const segments: AttendanceSegment[] = [];
  let breakMinutes = 0;
  let status: AttendanceStatus = "closed";
  let segmentStart: string | null = null;
  let breakStart: string | null = null;
  let firstInAt: string | null = null;
  let lastOutAt: string | null = null;

  for (const e of sorted(events)) {
    const check = checkTransition(status, e.eventType);
    if (!check.ok) continue; // אירוע לא-חוקי שנשמר אי-פעם — לא קורס, לא נספר (ר' הערה למעלה)

    switch (e.eventType) {
      case "day_open":
        segmentStart = e.reportedForAt;
        if (!firstInAt) firstInAt = e.reportedForAt;
        break;
      case "break_start":
        if (segmentStart) {
          segments.push({ startAt: segmentStart, endAt: e.reportedForAt });
          segmentStart = null;
        }
        breakStart = e.reportedForAt;
        break;
      case "break_end":
        if (breakStart) {
          breakMinutes += minutesBetween(breakStart, e.reportedForAt);
          breakStart = null;
        }
        segmentStart = e.reportedForAt;
        break;
      case "day_close":
        // סוגר הפסקה פתוחה (on_break→day_close, ר' docstring על VALID_TRANSITIONS) בלי להמציא עבודה.
        if (breakStart) {
          breakMinutes += minutesBetween(breakStart, e.reportedForAt);
          breakStart = null;
        }
        if (segmentStart) {
          segments.push({ startAt: segmentStart, endAt: e.reportedForAt });
          segmentStart = null;
        }
        lastOutAt = e.reportedForAt;
        break;
    }
    status = check.nextStatus;
  }

  const netMs = segments.reduce((sum, s) => sum + (s.endAt ? minutesBetween(s.startAt, s.endAt) : 0), 0);

  return {
    status,
    segments,
    netMinutes: status === "closed" ? Math.round(netMs) : null,
    breakMinutes: Math.round(breakMinutes),
    segmentCount: segments.length,
    firstInAt,
    lastOutAt,
  };
}

export interface LiveDaySummary extends DaySummary {
  /** שעות נטו *עד עכשיו* (asOfIso) — אם status==="working", כולל את המקטע הפתוח הנוכחי, מחושב
   *  עד asOfIso בלבד. **הערכה זמנית** — לא "שעות מאושרות" (אלו רק כש-status==="closed", ר' netMinutes). */
  netMinutesSoFar: number;
  /** דקות הפסקה *עד עכשיו* — אם status==="on_break", כולל את ההפסקה הפתוחה הנוכחית. */
  breakMinutesSoFar: number;
  /** true ⇔ status!=="closed" — netMinutesSoFar/breakMinutesSoFar הם הערכה זמנית, לא ערך סופי. */
  isEstimate: boolean;
}

/**
 * גרסה "חיה" של computeDaySummary, לכלי קריאה בלבד (attendance_day_status) — כמה שעות עבדת/
 * הפסקת *עד עכשיו*, גם כשהיום עדיין פתוח/בהפסקה. asOfIso הוא גבול-תצוגה בלבד (לא נכתב לשום
 * event/correction) — פונקציה טהורה, מריצה את אותה לולאת state-machine כמו computeDaySummary
 * בנפרד (בכוונה לא refactor משותף, כדי לא ליצור סיכון רגרסיה בפונקציה הקיימת והנבדקת).
 */
export function computeLiveDaySummary(events: readonly AttendanceEventLike[], asOfIso: string): LiveDaySummary {
  const segments: AttendanceSegment[] = [];
  let breakMinutes = 0;
  let status: AttendanceStatus = "closed";
  let segmentStart: string | null = null;
  let breakStart: string | null = null;
  let firstInAt: string | null = null;
  let lastOutAt: string | null = null;

  for (const e of sorted(events)) {
    const check = checkTransition(status, e.eventType);
    if (!check.ok) continue;
    switch (e.eventType) {
      case "day_open":
        segmentStart = e.reportedForAt;
        if (!firstInAt) firstInAt = e.reportedForAt;
        break;
      case "break_start":
        if (segmentStart) {
          segments.push({ startAt: segmentStart, endAt: e.reportedForAt });
          segmentStart = null;
        }
        breakStart = e.reportedForAt;
        break;
      case "break_end":
        if (breakStart) {
          breakMinutes += minutesBetween(breakStart, e.reportedForAt);
          breakStart = null;
        }
        segmentStart = e.reportedForAt;
        break;
      case "day_close":
        if (breakStart) {
          breakMinutes += minutesBetween(breakStart, e.reportedForAt);
          breakStart = null;
        }
        if (segmentStart) {
          segments.push({ startAt: segmentStart, endAt: e.reportedForAt });
          segmentStart = null;
        }
        lastOutAt = e.reportedForAt;
        break;
    }
    status = check.nextStatus;
  }

  const netMsClosed = segments.reduce((sum, s) => sum + (s.endAt ? minutesBetween(s.startAt, s.endAt) : 0), 0);
  let netMinutesSoFar = netMsClosed;
  let breakMinutesSoFar = breakMinutes;
  if (status === "working" && segmentStart) netMinutesSoFar += minutesBetween(segmentStart, asOfIso);
  if (status === "on_break" && breakStart) breakMinutesSoFar += minutesBetween(breakStart, asOfIso);

  return {
    status,
    segments,
    netMinutes: status === "closed" ? Math.round(netMsClosed) : null,
    breakMinutes: Math.round(breakMinutes),
    segmentCount: segments.length,
    firstInAt,
    lastOutAt,
    netMinutesSoFar: Math.round(netMinutesSoFar),
    breakMinutesSoFar: Math.round(breakMinutesSoFar),
    isEstimate: status !== "closed",
  };
}

/**
 * מפתח יציב, לא תלוי-זמן, לפעולה/הודעה בודדת — **לא** דלי-זמן (audit שלב ג, 2026-10-11: דלי-דקה
 * היה חוסם בטעות שני מקטעים לגיטימיים (למשל שתי יציאות-הפסקה נפרדות) שנפלו באותה דקה בפועל).
 * messageSeed מגיע מ-buildMessageIdempotencySeed למטה — יציב עבור *אותה* הודעה בדיוק (resend/retry),
 * שונה בין שתי הודעות אמיתיות שונות (גם אם תוכנן זהה מילה-במילה, כי ה-history המצטבר שהן נשלחו
 * בתוכו כבר שונה ביניהן — ר' docstring של buildMessageIdempotencySeed). day_open נשאר מפתח יחיד
 * פר-(עובד,יום) בלי תלות ב-messageSeed בכלל — אין "שני day_open" אפשריים ביום, גם אם ינסו משני
 * ערוצים/הודעות שונות.
 */
export function buildEventIdempotencyKey(
  userKey: string,
  eventType: AttendanceEventType,
  workDate: string,
  messageSeed: string,
): string {
  if (eventType === "day_open") return `${userKey}:day_open:${workDate}`;
  return `${userKey}:${eventType}:${workDate}:${messageSeed}`;
}

/**
 * מזהה יציב להודעה/פעולה בודדת — audit שלב ד (2026-10-11): הגרסה הקודמת גיבבה את מערך ה-history
 * המלא כפי שהתקבל בבקשה. זה שבר את "יציב בין ניסיון מקורי לחוזר" בפועל: history יכול להשתנות בין
 * שני ניסיונות של *אותה* בקשה בלי שום דבר לוגי קרה (slice(-20) בשרת, היסטוריה שנטענה-מחדש מה-DB
 * בניסיון השני ולא זהה byte-for-byte למערך שהלקוח שלח במקור, וכו') — ואז ה-hash היה משתנה וה-retry
 * לא היה מזוהה. הגרסה הזו **לא תלויה בתוכן/אורך history בכלל**.
 *
 * שתי שכבות, לפי MessageIdentity:
 *   1. channelMessageId — מזהה שהערוץ עצמו מקצה ויציב מצידו (WhatsApp/Baileys: message.key.id —
 *      לא תלוי בשרת שלנו בכלל). **מועדף תמיד כשקיים.**
 *   2. turnOrdinal — fallback כש-אין מזהה ערוץ (החלונית היום): מספר הודעות-המשתמש *שכבר נשמרו
 *      בפועל* באותה שיחה (countUserMessagesInSession, chatHistory.ts), נספר *לפני* שמירת ההודעה
 *      הנוכחית. יציב לפי בנייה: appendChatTurn קורה רק אחרי ש-runOpsChat מחזיר תוצאה — אם הניסיון
 *      המקורי קרס/נכשל, retry סופר את אותו מספר בדיוק (שום דבר לא נשמר ביניהם); הודעה חדשה אמיתית
 *      מגיעה רק *אחרי* ש-הקודמת נשמרה, אז הספירה גדלה. לא תלוי ב-history הנכנס לבקשה בכלל.
 * חסרים שניהם → זו שגיאת-תכנות (קורא לא תקין), לא מצב-ריצה תקין — נזרקת שגיאה מפורשת, לא "fallback
 * חרישי" שלישי שעלול להתברר לא-יציב בעצמו.
 */
export interface MessageIdentity {
  /** מזהה הודעה יציב מהערוץ עצמו (למשל Baileys message.key.id). מועדף תמיד כשקיים. */
  channelMessageId?: string;
  /** session_id (חלונית) / jid (WhatsApp) — מבדיל בין שיחות נפרדות כש-משתמשים ב-turnOrdinal. */
  scopeId: string;
  /** מספר הודעות-משתמש שכבר נשמרו בשיחה הזו, *לפני* ההודעה הנוכחית. */
  turnOrdinal?: number;
}

export function buildMessageIdempotencySeed(identity: MessageIdentity): string {
  if (identity.channelMessageId) return `cmid:${identity.channelMessageId}`;
  if (identity.turnOrdinal != null) return `turn:${identity.scopeId}:${identity.turnOrdinal}`;
  throw new Error("buildMessageIdempotencySeed: אין channelMessageId ולא turnOrdinal — אין בסיס יציב ל-idempotency.");
}

/** YYYY-MM-DD לפי ה-DateTime שהתקבל — הקורא אחראי להעביר DateTime שכבר ב-env.TIMEZONE. */
export function workDateFor(now: DateTime): string {
  return now.toISODate()!;
}

/** YYYY-MM מתוך work_date — לקביעת חודש השכר הרלוונטי לתיקון. */
export function payrollMonthFor(workDate: string): string {
  return workDate.slice(0, 7);
}

export interface CorrectionOverlay {
  correctsEventId: number;
  reportedForAt: string;
}

/**
 * מחזירה *עותק* של האירועים עם reportedForAt מוחלף לפי תיקונים שהוחלו — אינה נוגעת ב-DB,
 * אינה כותבת UPDATE על שום רשומה. משמשת רק כקלט ל-computeDaySummary/statusAfter/validateEventSequence.
 */
export function applyCorrections(
  events: readonly AttendanceEventLike[],
  corrections: readonly CorrectionOverlay[],
): AttendanceEventLike[] {
  if (corrections.length === 0) return [...events];
  const overrides = new Map(corrections.map((c) => [c.correctsEventId, c.reportedForAt]));
  return events.map((e) => (e.id != null && overrides.has(e.id) ? { ...e, reportedForAt: overrides.get(e.id)! } : e));
}

/** "N שעות ו-M דקות" / "N דקות" — לטקסט סיכום יום, בלי לוגיקה חוזרת בכל מקום שמציג net/break. */
export function formatMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} דקות`;
  if (m === 0) return `${h} שעות`;
  return `${h} שעות ו-${m} דקות`;
}
