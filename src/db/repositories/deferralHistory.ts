import { db } from "../db.js";

/**
 * היסטוריית דחיות של משימת Monday אחת — לפי itemId+itemSource, לא לפי finding_key.
 *
 * למה זה חשוב (Audit 2026-09-14): finding_key הוא `${kind}:${itemId}` (למשל overdue:12345,
 * stuck:12345, blocking:12345). אותה משימה עצמה יכולה לעבור בין kind-ים לאורך זמן — פעם מסומנת
 * "תקוע", פעם "באיחור", פעם "חוסם אחרים" — ולכל אחד finding_key שונה. אם סופרים דחיות לפי
 * finding_key בלבד, מעבר כזה "מאפס" בטעות את מספר הדחיות הידוע של המשימה.
 *
 * הפתרון: לא טבלה חדשה ולא מיגרציה. control_findings כבר שומרת item_id+item_source לכל
 * finding_key (מ-2026-09-10). מצטרפים (JOIN) דרך finding_key כדי למשוך את כל אירועי ה-"snoozed"
 * ששייכים לאותו itemId, לא משנה תחת איזה finding_key הם נרשמו. finding_events לא משתנה כלל —
 * לא נמחק ולא נוסף אליו column — רק נקרא בצירוף עם control_findings.
 */

export interface DeferralHistoryRecord {
  /** מתי בוצעה הבקשה (ISO, מ-finding_events.created_at) */
  requestedAt: string;
  /**
   * האם המשימה כבר הייתה באיחור כשהבקשה נעשתה. נקרא מ-payload.wasOverdue האמיתי שנשמר בזמן
   * היצירה (Audit 2026-09-18, Gap #1 — ר' loadDeferralHistoryForItem למטה) — לא מונח יותר.
   */
  wasOverdue: boolean;
  /** התאריך החדש שהתבקש, YYYY-MM-DD */
  newDueDate: string;
}

interface Row {
  created_at: string;
  payload_json: string | null;
}

const stmt = db.prepare(`
  SELECT fe.created_at AS created_at, fe.payload_json AS payload_json
  FROM finding_events fe
  JOIN control_findings cf ON cf.finding_key = fe.finding_key
  WHERE cf.item_id = ? AND cf.item_source = ? AND fe.event = 'snoozed'
  ORDER BY fe.id ASC
`);

/**
 * כל בקשות הדחייה הידועות של משימת Monday אחת, ממויינות מהישנה לחדשה — לא משנה כמה finding_key
 * שונים היא עברה. סינון לפי item_id+item_source בלבד (WHERE, לא JOIN לא-מסונן) — אי אפשר לקבל
 * בטעות אירועים ששייכים ל-itemId אחר: כל שורה חייבת להתאים ל-cf.item_id שהתבקש.
 *
 * Audit 2026-09-18 (Gap #1): עד עכשיו כל שורה סומנה wasOverdue=true בכוונה-תחילה — כלומר
 * countDeferrals ב-policy.ts תמיד סיווג כל היסטוריה כ-afterOverdue, ואף פעם לא כ-beforeOverdue.
 * בפועל שתי נקודות היצירה היחידות של אירוע "snoozed" (loopReply.replyDefer, שורה ~404;
 * approvalActions.recordApproved, שורה ~160) כבר שומרות wasOverdue אמיתי ב-payload מאז שהשדה
 * נוסף — פשוט לא נקרא. עכשיו כן נקרא.
 *
 * Legacy rows (payload.wasOverdue===undefined, אירוע "snoozed" שנכתב *לפני* שהשדה נוסף
 * ל-payload): נופלות חזרה ל-true — **בדיוק ההתנהגות שהייתה להן לפני התיקון הזה**, לא שינוי
 * שקט. הנימוק: אין לנו מידע אמיתי על אותן שורות ישנות אם היו לפני/אחרי יעד, ולהניח beforeOverdue
 * "כברירת מחדל חדשה" היה ניחוש חדש באותה מידה — רק בכיוון ההפוך, ובלי סימוכין. השארת true
 * היא הבחירה השמרנית: לא הופכת בשקט משהו שנספר עד היום כ-afterOverdue ל-beforeOverdue.
 */
export function loadDeferralHistoryForItem(itemId: string, itemSource: string): DeferralHistoryRecord[] {
  const rows = stmt.all(itemId, itemSource) as unknown as Row[];
  const out: DeferralHistoryRecord[] = [];
  for (const r of rows) {
    if (!r.payload_json) continue;
    const payload = JSON.parse(r.payload_json) as { snoozeUntil?: string; wasOverdue?: boolean };
    if (!payload.snoozeUntil) continue;
    const wasOverdue = payload.wasOverdue ?? true; // legacy fallback — ר' docstring למעלה
    out.push({ requestedAt: r.created_at, wasOverdue, newDueDate: payload.snoozeUntil });
  }
  return out;
}
