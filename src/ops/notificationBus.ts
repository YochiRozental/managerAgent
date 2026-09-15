/**
 * ערוץ בזמן-אמת גנרי — כמו nudgeBus.ts, אבל לא רק ל"נודג'" (פנייה יזומה של הבקרה). משמש היום:
 *   • התראת "נדרש אישור" חדשה למוטי (event: approval)
 *   • הודעת החלטה לעובד — אושר/נדחה/הנחיה (event: notification)
 * לא מחליף את nudgeBus.ts — nudge-ים ממשיכים לזרום שם, בלי שינוי, כדי לא לגעת בזרימה הקיימת
 * והבדוקה. זה כאן ל*חדש* בלבד: קריאות מפורשות מהקוד שיוצר Approval/מודיע לעובד על החלטה,
 * בדיוק כמו ש-escalation.ts קורא ל-publishNudge בנפרד מ-addNotification.
 */

export interface BusNotification {
  userKey: string;
  id: number;
  kind: string;
  body: string;
  findingKey: string | null;
  itemId: string | null;
  itemSource: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
}

type Listener = (n: BusNotification) => void;
const listeners = new Set<Listener>();

export function subscribeNotifications(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publishNotificationLive(n: BusNotification): void {
  for (const fn of listeners) {
    try {
      fn(n);
    } catch {
      /* מנוי שבור לא מפיל את השאר */
    }
  }
}
