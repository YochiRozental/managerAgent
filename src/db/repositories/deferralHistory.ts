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
   * האם המשימה כבר הייתה באיחור כשהבקשה נעשתה. היום זה תמיד true: כל "snoozed" קיים נוצר אך ורק
   * כתשובה לפנייה יזומה על ממצא שכבר סומן (overdue/stuck/...) — אין עדיין מסלול לדחייה "מראש"
   * (לפני שיש ממצא בכלל, כלל 4). כשזה ייפתח, נקודת ההרחבה היא כאן: לתעד wasOverdue בפועל
   * ב-payload בזמן הכתיבה, במקום להניח true.
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
 */
export function loadDeferralHistoryForItem(itemId: string, itemSource: string): DeferralHistoryRecord[] {
  const rows = stmt.all(itemId, itemSource) as unknown as Row[];
  const out: DeferralHistoryRecord[] = [];
  for (const r of rows) {
    if (!r.payload_json) continue;
    const payload = JSON.parse(r.payload_json) as { snoozeUntil?: string };
    if (!payload.snoozeUntil) continue;
    out.push({ requestedAt: r.created_at, wasOverdue: true, newDueDate: payload.snoozeUntil });
  }
  return out;
}
