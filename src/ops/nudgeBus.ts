/**
 * ערוץ בזמן-אמת לפניות יזומות: מנוע הבקרה מפרסם "נודג'", ומנוי SSE (חלון פתוח) מקבל מייד.
 * מודול עלה — בלי תלות בשרת או במנוע — כדי ששניהם יוכלו לייבא אותו בלי מעגל.
 * אם אף חלון לא פתוח: אין מנויים, ההודעה כבר נשמרה כ-notification ותיטען בפתיחה הבאה.
 */

export interface NudgePayload {
  userKey: string;
  findingKey: string;
  itemId: string | null;
  itemSource: string | null;
  body: string;
  taskName: string | null;
  project: string | null;
  createdAt: string;
}

type Listener = (n: NudgePayload) => void;
const listeners = new Set<Listener>();

/** מנוי (מ-GET /api/events). מחזיר פונקציית ניתוק. */
export function subscribeNudges(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publishNudge(n: NudgePayload): void {
  for (const fn of listeners) {
    try {
      fn(n);
    } catch {
      /* מנוי שבור לא מפיל את השאר */
    }
  }
}

export function nudgeSubscriberCount(): number {
  return listeners.size;
}
