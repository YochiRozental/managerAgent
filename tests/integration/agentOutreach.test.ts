/**
 * פניות יזומות של הסוכן לעובד (שלב 1 — תשתית נתונים). DB זמני מבודד בלבד (tests/setup).
 * מכסה: מחזור חיים (draft/ביטול/פקיעה/CAS/השלמה), בידוד בין משתמשים ושיחות, שיוך הודעת צוות אחת לפנייה
 * אחת, זיהוי תשובה מפורשת בלבד (reply_to_id), עריכה/מחיקה, הרצה חוזרת של הסכמה, ושהמודול לא נוגע
 * במוני unread / בהתנהגות הודעות הצוות.
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/db.js";
import {
  cancelDraft,
  claimForSending,
  completeSend,
  createDraft,
  expireDrafts,
  findOutreachAnsweredBy,
  getOutreach,
  getOutreachInSession,
  getPendingDraft,
  listOutreach,
  listRepliesForSession,
  listSending,
  outreachClientMessageId,
} from "../../src/db/repositories/agentOutreach.js";
import {
  DELETED_PLACEHOLDER,
  deleteMessage,
  editMessage,
  listThreads,
  openDm,
  sendMessage,
  unreadTotal,
} from "../../src/db/repositories/teamMessages.js";

const ME = "dov";
const WORKER = "eitan";
const OTHER = "ruchama";
const S1 = "s-one";
const S2 = "s-two";

const future = () => new Date(Date.now() + 30 * 60_000);
const past = () => new Date(Date.now() - 60_000);

function clean(): void {
  db.exec(`DELETE FROM agent_outreach`);
  db.exec(`DELETE FROM team_messages`);
  db.exec(`DELETE FROM team_thread_members`);
  db.exec(`DELETE FROM team_threads`);
}

function draft(over: Partial<Parameters<typeof createDraft>[0]> = {}) {
  return createDraft({
    userKey: ME,
    sessionId: S1,
    recipientKey: WORKER,
    body: "שלום, אפשר עדכון על התכניות?",
    createdTurn: "turn-1",
    expiresAt: future(),
    ...over,
  });
}

/** פנייה שנשלחה בפועל: draft → sending → הודעת צוות (כמו שהשכבה הבאה תעשה) → sent. */
function sentOutreach(over: Partial<Parameters<typeof createDraft>[0]> = {}) {
  const o = draft(over);
  expect(claimForSending(o.id, o.userKey, o.sessionId)).toBe(true);
  const { threadId } = openDm(o.userKey, o.recipientKey);
  const { message } = sendMessage(o.userKey, threadId, o.body, outreachClientMessageId(o.id));
  expect(completeSend(o.id, o.userKey, message.id, threadId)).toBe("ok");
  return { outreach: getOutreach(o.id, o.userKey)!, threadId, messageId: message.id };
}

let n = 0;
const cid = () => `r-${++n}`;

beforeEach(clean);

describe("טיוטה", () => {
  it("יוצרת וקוראת טיוטה ממתינה עם כל השדות", () => {
    const o = draft();
    expect(o.id).toMatch(/^ao_/);
    expect(o).toMatchObject({ userKey: ME, sessionId: S1, recipientKey: WORKER, status: "draft", createdTurn: "turn-1", teamMessageId: null, threadId: null, sentAt: null });
    expect(getPendingDraft(ME, S1)?.id).toBe(o.id);
  });

  it("טיוטה חדשה באותו הקשר מבטלת את הקודמת; שיחה אחרת לא מושפעת", () => {
    const a = draft();
    const other = draft({ sessionId: S2 });
    const b = draft({ body: "נוסח חדש" });
    expect(getOutreach(a.id, ME)?.status).toBe("cancelled");
    expect(getPendingDraft(ME, S1)?.id).toBe(b.id);
    expect(getOutreach(other.id, ME)?.status).toBe("draft");
    expect(claimForSending(a.id, ME, S1)).toBe(false);
  });

  it("cancelDraft מבטל רק draft", () => {
    const o = draft();
    expect(cancelDraft(o.id, ME, S1)).toBe(true);
    expect(cancelDraft(o.id, ME, S1)).toBe(false);
    expect(getPendingDraft(ME, S1)).toBeNull();
  });

  it("דוחה גוף ריק, ארוך מדי ופנייה לעצמך", () => {
    expect(() => draft({ body: "   " })).toThrow();
    expect(() => draft({ body: "א".repeat(4001) })).toThrow();
    expect(() => draft({ recipientKey: ME })).toThrow();
  });
});

describe("פקיעת תוקף", () => {
  it("טיוטה שפג תוקפה לא נקראת ולא ניתנת לאישור; expireDrafts מסמן אותה", () => {
    const o = draft({ expiresAt: past() });
    expect(getPendingDraft(ME, S1)).toBeNull();
    expect(claimForSending(o.id, ME, S1)).toBe(false);
    expect(getOutreach(o.id, ME)?.status).toBe("draft");
    expect(expireDrafts()).toBe(1);
    expect(getOutreach(o.id, ME)?.status).toBe("expired");
    expect(expireDrafts()).toBe(0);
  });

  it("expireDrafts לא נוגע בטיוטה תקפה או בפנייה שכבר ב-sending", () => {
    const live = draft({ sessionId: S2 });
    const o = draft();
    expect(claimForSending(o.id, ME, S1)).toBe(true);
    expect(expireDrafts(new Date(Date.now() + 3 * 60 * 60_000))).toBe(1); // רק live, שפג בעתיד
    expect(getOutreach(live.id, ME)?.status).toBe("expired");
    expect(getOutreach(o.id, ME)?.status).toBe("sending");
  });
});

describe("CAS ואמינות", () => {
  it("שני אישורים מקבילים — רק אחד מצליח", async () => {
    const o = draft();
    const results = await Promise.all([
      Promise.resolve().then(() => claimForSending(o.id, ME, S1)),
      Promise.resolve().then(() => claimForSending(o.id, ME, S1)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(getOutreach(o.id, ME)?.status).toBe("sending");
  });

  it("CAS אטומי גם בין שני חיבורים נפרדים ל-DB (תהליכים)", () => {
    const o = draft();
    const second = new DatabaseSync(process.env.AGENT_DB_PATH!);
    second.exec("PRAGMA busy_timeout = 5000");
    try {
      const raw = second.prepare(
        `UPDATE agent_outreach SET status = 'sending' WHERE id = ? AND user_key = ? AND session_id = ? AND status = 'draft'`,
      );
      const viaRepo = claimForSending(o.id, ME, S1);
      const viaSecond = Number(raw.run(o.id, ME, S1).changes) === 1;
      expect([viaRepo, viaSecond].filter(Boolean)).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("אי אפשר לאשר שוב פנייה שב-sending או sent", () => {
    const { outreach } = sentOutreach();
    expect(claimForSending(outreach.id, ME, S1)).toBe(false);
    const o = draft({ sessionId: S2 });
    expect(claimForSending(o.id, ME, S2)).toBe(true);
    expect(claimForSending(o.id, ME, S2)).toBe(false);
  });

  it("sending נשאר sending — אין איפוס אוטומטי; ניתן לאתר אותו להתאוששות עם clientMessageId קבוע", () => {
    const o = draft();
    claimForSending(o.id, ME, S1);
    expect(expireDrafts(new Date(Date.now() + 24 * 60 * 60_000))).toBe(0);
    expect(getPendingDraft(ME, S1)).toBeNull();
    const stuck = listSending(ME);
    expect(stuck.map((x) => x.id)).toEqual([o.id]);
    expect(outreachClientMessageId(o.id)).toBe(`ao:${o.id}`);

    // התאוששות עתידית: שליחה חוזרת עם אותו מזהה מחזירה את ההודעה הקיימת ולא יוצרת שנייה
    const { threadId } = openDm(ME, WORKER);
    const first = sendMessage(ME, threadId, o.body, outreachClientMessageId(o.id));
    const again = sendMessage(ME, threadId, o.body, outreachClientMessageId(o.id));
    expect(again.duplicate).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    expect(completeSend(o.id, ME, again.message.id, threadId)).toBe("ok");
  });
});

describe("השלמת שליחה", () => {
  it("שומרת team_message_id ו-thread_id ו-sent_at", () => {
    const { outreach, threadId, messageId } = sentOutreach();
    expect(outreach).toMatchObject({ status: "sent", teamMessageId: messageId, threadId });
    expect(outreach.sentAt).not.toBeNull();
  });

  it("completeSend אידמפוטנטי לאותה הודעה, ונדחה על draft או הודעה אחרת", () => {
    const { outreach, threadId, messageId } = sentOutreach();
    expect(completeSend(outreach.id, ME, messageId, threadId)).toBe("ok");
    expect(completeSend(outreach.id, ME, messageId + 100, threadId)).toBe("not_sending");
    const d = draft({ sessionId: S2 });
    expect(completeSend(d.id, ME, messageId, threadId)).toBe("not_sending");
    expect(getOutreach(d.id, ME)?.status).toBe("draft");
  });

  it("הודעת צוות אחת לא משויכת לשתי פניות", () => {
    const { threadId, messageId } = sentOutreach();
    const second = draft({ sessionId: S2 });
    claimForSending(second.id, ME, S2);
    expect(completeSend(second.id, ME, messageId, threadId)).toBe("message_already_linked");
    expect(getOutreach(second.id, ME)?.status).toBe("sending");
    expect(getOutreach(second.id, ME)?.teamMessageId).toBeNull();
  });
});

describe("בידוד", () => {
  it("משתמש אחר לא קורא, לא מאשר ולא מבטל פנייה של אחר", () => {
    const o = draft();
    expect(getOutreach(o.id, OTHER)).toBeNull();
    expect(getOutreachInSession(o.id, OTHER, S1)).toBeNull();
    expect(getPendingDraft(OTHER, S1)).toBeNull();
    expect(claimForSending(o.id, OTHER, S1)).toBe(false);
    expect(cancelDraft(o.id, OTHER, S1)).toBe(false);
    expect(listOutreach(OTHER, S1)).toEqual([]);
    expect(getOutreach(o.id, ME)?.status).toBe("draft");
  });

  it("שיחת סוכן אחרת של אותו משתמש לא רואה ולא מאשרת", () => {
    const o = draft();
    expect(getPendingDraft(ME, S2)).toBeNull();
    expect(getOutreachInSession(o.id, ME, S2)).toBeNull();
    expect(claimForSending(o.id, ME, S2)).toBe(false);
    expect(cancelDraft(o.id, ME, S2)).toBe(false);
    expect(listOutreach(ME, S2)).toEqual([]);
    expect(listOutreach(ME, S1).map((x) => x.id)).toEqual([o.id]);
  });

  it("תשובות לא נחשפות למשתמש אחר או לשיחת סוכן אחרת", () => {
    const { outreach, threadId, messageId } = sentOutreach();
    sendMessage(WORKER, threadId, "מצורף", cid(), messageId);
    expect(listRepliesForSession(ME, S1)).toHaveLength(1);
    expect(listRepliesForSession(ME, S2)).toEqual([]);
    expect(listRepliesForSession(OTHER, S1)).toEqual([]);
    expect(listRepliesForSession(WORKER, S1)).toEqual([]); // גם הנמען עצמו אינו בעל הפנייה
    expect(outreach.userKey).toBe(ME);
  });
});

describe("זיהוי תשובה", () => {
  it("תגובה מפורשת (reply_to_id) של הנמען מזוהה", () => {
    const { outreach, threadId, messageId } = sentOutreach();
    const { message } = sendMessage(WORKER, threadId, "שלחתי את התכניות", cid(), messageId);
    const replies = listRepliesForSession(ME, S1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ outreachId: outreach.id, messageId: message.id, threadId, senderKey: WORKER, body: "שלחתי את התכניות", deleted: false });
    expect(findOutreachAnsweredBy(messageId, threadId, WORKER)?.id).toBe(outreach.id);
  });

  it("הודעה רגילה (בלי reply_to_id) אינה תשובה", () => {
    const { threadId } = sentOutreach();
    sendMessage(WORKER, threadId, "היי, שאלה אחרת", cid());
    expect(listRepliesForSession(ME, S1)).toEqual([]);
  });

  it("תגובה להודעה אחרת בשיחה אינה תשובה לפנייה", () => {
    const { threadId } = sentOutreach();
    const other = sendMessage(WORKER, threadId, "הודעה שלי", cid()).message;
    sendMessage(WORKER, threadId, "תגובה להודעה שלי", cid(), other.id);
    expect(listRepliesForSession(ME, S1)).toEqual([]);
    expect(findOutreachAnsweredBy(other.id, threadId, WORKER)).toBeNull();
  });

  it("תגובה של השולח עצמו להודעת הפנייה אינה תשובה", () => {
    const { threadId, messageId } = sentOutreach();
    sendMessage(ME, threadId, "הוספה שלי", cid(), messageId);
    expect(listRepliesForSession(ME, S1)).toEqual([]);
    expect(findOutreachAnsweredBy(messageId, threadId, ME)).toBeNull();
  });

  it("פנייה שלא נשלחה (draft/sending) לא מניבה תשובות", () => {
    const d = draft();
    expect(findOutreachAnsweredBy(1, 1, WORKER)).toBeNull();
    claimForSending(d.id, ME, S1);
    expect(listRepliesForSession(ME, S1)).toEqual([]);
    expect(findOutreachAnsweredBy(null, 1, WORKER)).toBeNull();
  });

  it("כמה פניות פתוחות לאותו עובד — כל תשובה משויכת לפנייה שלה", () => {
    const a = sentOutreach({ body: "פנייה א", createdTurn: "t1" });
    const b = sentOutreach({ body: "פנייה ב", createdTurn: "t2" });
    expect(a.threadId).toBe(b.threadId);
    const rb = sendMessage(WORKER, b.threadId, "תשובה ל-ב", cid(), b.messageId).message;
    const ra = sendMessage(WORKER, a.threadId, "תשובה ל-א", cid(), a.messageId).message;
    const replies = listRepliesForSession(ME, S1);
    expect(replies.map((r) => [r.outreachId, r.messageId])).toEqual([
      [b.outreach.id, rb.id],
      [a.outreach.id, ra.id],
    ]);
    expect(findOutreachAnsweredBy(a.messageId, a.threadId, WORKER)?.id).toBe(a.outreach.id);
  });

  it("afterMessageId מחזיר רק תשובות חדשות (catch-up)", () => {
    const { threadId, messageId } = sentOutreach();
    const r1 = sendMessage(WORKER, threadId, "ראשונה", cid(), messageId).message;
    const r2 = sendMessage(WORKER, threadId, "שנייה", cid(), messageId).message;
    expect(listRepliesForSession(ME, S1, r1.id).map((r) => r.messageId)).toEqual([r2.id]);
  });

  it("תשובה שנערכה מציגה נוסח עדכני; תשובה שנמחקה מציגה placeholder בלי התוכן המקורי", () => {
    const { threadId, messageId } = sentOutreach();
    const reply = sendMessage(WORKER, threadId, "נוסח ראשון", cid(), messageId).message;
    editMessage(WORKER, reply.id, "נוסח מתוקן", threadId);
    expect(listRepliesForSession(ME, S1)[0]).toMatchObject({ body: "נוסח מתוקן", deleted: false });
    deleteMessage(WORKER, reply.id, threadId);
    const [after] = listRepliesForSession(ME, S1);
    expect(after).toMatchObject({ body: DELETED_PLACEHOLDER, deleted: true });
    expect(JSON.stringify(after)).not.toContain("נוסח");
  });
});

describe("אין השפעה על הודעות צוות", () => {
  it("קריאת תשובות וזיהוי לא משנים unread ולא מסמנים נקרא", () => {
    const { threadId, messageId } = sentOutreach();
    sendMessage(WORKER, threadId, "תשובה", cid(), messageId);
    const unreadBefore = unreadTotal(ME);
    const threadBefore = listThreads(ME).find((t) => t.id === threadId)!;
    expect(unreadBefore).toBe(1);
    listRepliesForSession(ME, S1);
    findOutreachAnsweredBy(messageId, threadId, WORKER);
    listOutreach(ME, S1);
    expect(unreadTotal(ME)).toBe(unreadBefore);
    const threadAfter = listThreads(ME).find((t) => t.id === threadId)!;
    expect(threadAfter.unread).toBe(threadBefore.unread);
    expect(threadAfter.lastReadMessageId).toBe(threadBefore.lastReadMessageId);
  });

  it("אין שורות ב-notifications מפעולות הפנייה", () => {
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM notifications`).get() as { n: number }).n;
    const { threadId, messageId } = sentOutreach();
    sendMessage(WORKER, threadId, "תשובה", cid(), messageId);
    listRepliesForSession(ME, S1);
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM notifications`).get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe("סכמה", () => {
  it("הרצה חוזרת של schema.sql לא שוברת ולא משנה נתונים", () => {
    const { outreach } = sentOutreach();
    const snapshot = JSON.stringify(db.prepare(`SELECT * FROM agent_outreach ORDER BY id`).all());
    const teamSnapshot = JSON.stringify(db.prepare(`SELECT * FROM team_messages ORDER BY id`).all());
    const schema = fs.readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf-8");
    expect(() => db.exec(schema)).not.toThrow();
    expect(() => db.exec(schema)).not.toThrow();
    expect(JSON.stringify(db.prepare(`SELECT * FROM agent_outreach ORDER BY id`).all())).toBe(snapshot);
    expect(JSON.stringify(db.prepare(`SELECT * FROM team_messages ORDER BY id`).all())).toBe(teamSnapshot);
    expect(getOutreach(outreach.id, ME)?.status).toBe("sent");
  });

  it("אילוצים ב-DB: סטטוס לא חוקי נדחה, sent בלי הודעה נדחה, UNIQUE על team_message_id", () => {
    const ins = (id: string, status: string, tm: number | null, th: number | null) =>
      db
        .prepare(
          `INSERT INTO agent_outreach (id, user_key, session_id, recipient_key, body, status, created_turn, expires_at, team_message_id, thread_id)
           VALUES (?, 'a', 's', 'b', 'x', ?, 't', '2030-01-01T00:00:00.000Z', ?, ?)`,
        )
        .run(id, status, tm, th);
    expect(() => ins("x1", "bogus", null, null)).toThrow();
    expect(() => ins("x2", "sent", null, null)).toThrow();
    ins("x3", "sent", 900, 9);
    expect(() => ins("x4", "sent", 900, 9)).toThrow(/UNIQUE/i);
    ins("x5", "draft", null, null);
    ins("x6", "draft", null, null); // NULL-ים מרובים מותרים
  });
});
