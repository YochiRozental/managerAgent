/**
 * שלב "התראות ותזכורות" (2026-10-19) — src/db/repositories/notifications.ts: סימון נקרא
 * פר-התראה בודדת (markNotificationSeenById) ודפדוף היסטוריה (listNotificationsPage).
 * DB זמני מבודד (tests/setup/isolate.ts, AGENT_DB_PATH) — ר' tests/unit/chatPerfMetrics.test.ts
 * לדפוס הזהה.
 */

import "dotenv/config";
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../../src/db/db.js";
import {
  addNotification,
  listNotificationsPage,
  listUnseenNotifications,
  markNotificationSeenById,
} from "../../src/db/repositories/notifications.js";

const U1 = "nottest-u1";
const U2 = "nottest-u2";

function cleanup(): void {
  db.exec(`DELETE FROM notifications WHERE user_key IN ('${U1}', '${U2}')`);
}

beforeEach(() => cleanup());

describe("markNotificationSeenById — פר-התראה, לא גורף", () => {
  it("מסמן רק את השורה המבוקשת; לא משפיע על שום התראה אחרת של אותו משתמש", () => {
    const id1 = addNotification(U1, "task_assigned", "משימה א");
    const id2 = addNotification(U1, "task_assigned", "משימה ב");

    expect(markNotificationSeenById(U1, id1)).toBe(true);

    const unseen = listUnseenNotifications(U1);
    expect(unseen.map((n) => n.id)).toEqual([id2]);
  });

  it("false כש-ההתראה לא קיימת, לא של המשתמש הזה, או שכבר נקראה — בלי לזרוק", () => {
    const id = addNotification(U1, "task_assigned", "משימה");
    expect(markNotificationSeenById(U2, id)).toBe(false); // לא הבעלים
    expect(markNotificationSeenById(U1, 999999)).toBe(false); // לא קיימת
    expect(markNotificationSeenById(U1, id)).toBe(true); // הסימון האמיתי
    expect(markNotificationSeenById(U1, id)).toBe(false); // כבר נקראה — idempotent, לא שגיאה
  });

  it("לא מאפשר לסמן נודג'/אישור דרך ה-endpoint הגנרי (SPECIAL_KINDS מוחרג גם כאן)", () => {
    const nudgeId = addNotification(U1, "nudge", "פנייה יזומה", "finding-x");
    expect(markNotificationSeenById(U1, nudgeId)).toBe(false);
    const row = db.prepare(`SELECT seen_at FROM notifications WHERE id = ?`).get(nudgeId) as { seen_at: string | null };
    expect(row.seen_at).toBeNull();
  });
});

describe("listNotificationsPage — דפדוף היסטוריה, חדש→ישן", () => {
  it("מחזיר נקראות וגם לא-נקראות, מהחדש לישן", () => {
    const id1 = addNotification(U1, "task_assigned", "ראשונה");
    const id2 = addNotification(U1, "task_assigned", "שנייה");
    markNotificationSeenById(U1, id1);

    const page = listNotificationsPage(U1, 10);
    expect(page.map((n) => n.id)).toEqual([id2, id1]);
    expect(page.find((n) => n.id === id1)?.seenAt).not.toBeNull();
    expect(page.find((n) => n.id === id2)?.seenAt).toBeNull();
  });

  it("beforeId מחזיר את העמוד הבא בלי לחפוף לעמוד הקודם", () => {
    const ids = [1, 2, 3, 4, 5].map((i) => addNotification(U1, "task_assigned", `הודעה ${i}`));

    const firstPage = listNotificationsPage(U1, 2);
    expect(firstPage.map((n) => n.id)).toEqual([ids[4], ids[3]]);

    const secondPage = listNotificationsPage(U1, 2, firstPage[firstPage.length - 1].id);
    expect(secondPage.map((n) => n.id)).toEqual([ids[2], ids[1]]);

    const thirdPage = listNotificationsPage(U1, 2, secondPage[secondPage.length - 1].id);
    expect(thirdPage.map((n) => n.id)).toEqual([ids[0]]);
  });

  it("לא כולל נודג'ים/בקשות אישור — אותו SPECIAL_KINDS exclusion כמו listUnseenNotifications", () => {
    const taskId = addNotification(U1, "task_assigned", "משימה");
    addNotification(U1, "nudge", "פנייה", "finding-y");
    addNotification(U1, "approval_request", "בקשת אישור");

    const page = listNotificationsPage(U1, 10);
    expect(page.map((n) => n.id)).toEqual([taskId]);
  });

  it("מבודד בין משתמשים", () => {
    addNotification(U1, "task_assigned", "של משתמש 1");
    const u2Id = addNotification(U2, "task_assigned", "של משתמש 2");

    expect(listNotificationsPage(U2, 10).map((n) => n.id)).toEqual([u2Id]);
  });
});
