/**
 * "התראות שנקראו נשארות ברשימה הפעילה" (audit 2026-10-19) — הדרישה: read/unread (seen_at)
 * ו-open/resolved (control_findings/finding_events) הם שני צירים נפרדים לגמרי. סימון התראה
 * "נקרא" (markNotificationSeenById/markNotificationsSeen) **לעולם** לא נוגע בממצא עצמו —
 * ממצאי בקרה/התחייבויות פתוחות ממשיכים להיות פתוחים (ולהסלים בהתאם) גם אחרי שהעובד/מוטי קרא
 * את ההתראה. הבדיקה הזו מוכיחה את זה ישירות על DB אמיתי (לא רק grep על הקוד).
 */

import "dotenv/config";
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../../src/db/db.js";
import {
  addNotification,
  listUnseenNotifications,
  markNotificationSeenById,
  markNotificationsSeen,
} from "../../src/db/repositories/notifications.js";
import { recordFindingEvent, isResolvedByReply } from "../../src/db/repositories/findingEvents.js";

const U = "readvshandled-u1";
const FK = "readvshandled-finding-1";

function cleanup(): void {
  db.exec(`DELETE FROM notifications WHERE user_key = '${U}'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key = '${FK}'`);
  db.exec(`DELETE FROM control_findings WHERE finding_key = '${FK}'`);
}

beforeEach(() => cleanup());

function seedOpenFinding(): void {
  db.prepare(
    `INSERT INTO control_findings (finding_key, kind, severity, who, headline, detail, first_seen, last_seen, escalation_level)
     VALUES (?, 'overdue_stale', 'high', ?, 'כותרת', 'פרטים', datetime('now'), datetime('now'), 1)`,
  ).run(FK, U);
}

describe("סימון 'נקרא' לא נוגע בממצא עצמו", () => {
  it("markNotificationSeenById על התראת escalation לא כותב finding_event ולא נוגע ב-control_findings", () => {
    seedOpenFinding();
    const id = addNotification(U, "escalation", "הסלמה על ממצא פתוח", FK, { itemId: "999", itemSource: "general" });

    expect(markNotificationSeenById(U, id)).toBe(true);

    expect(isResolvedByReply(FK)).toBe(false);
    const findingRow = db.prepare(`SELECT resolved_at, escalation_level FROM control_findings WHERE finding_key = ?`).get(FK) as
      | { resolved_at: string | null; escalation_level: number }
      | undefined;
    expect(findingRow?.resolved_at ?? null).toBeNull();
    expect(findingRow?.escalation_level).toBe(1); // ללא שינוי
    expect(db.prepare(`SELECT COUNT(*) AS n FROM finding_events WHERE finding_key = ?`).get(FK)).toEqual({ n: 0 });
  });

  it("markNotificationsSeen (הגורף) גם הוא — לא נוגע בשום finding_event", () => {
    seedOpenFinding();
    addNotification(U, "escalation", "הסלמה 1", FK, { itemId: "1", itemSource: "general" });
    addNotification(U, "awaiting_decision", "ממתין להחלטה", FK, { itemId: "1", itemSource: "general" });

    markNotificationsSeen(U);

    expect(listUnseenNotifications(U).length).toBe(0);
    expect(isResolvedByReply(FK)).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM finding_events WHERE finding_key = ?`).get(FK)).toEqual({ n: 0 });
  });

  it("הממצא נסגר רק דרך recordFindingEvent('resolved_by_reply') — ציר נפרד לגמרי מ-seen_at", () => {
    seedOpenFinding();
    const id = addNotification(U, "escalation", "הסלמה", FK, { itemId: "1", itemSource: "general" });
    markNotificationSeenById(U, id); // "נקרא" — לא אמור לקרב לפתרון בכלל

    expect(isResolvedByReply(FK)).toBe(false);

    recordFindingEvent(FK, "resolved_by_reply", { byUser: U, action: "done" });
    expect(isResolvedByReply(FK)).toBe(true); // רק עכשיו, דרך האירוע הנכון — לא דרך "נקרא"
  });
});
