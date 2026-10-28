/**
 * פניות הסוכן — שלב 4: זיהוי תשובה מפורשת, עדכון בשיחת הסוכן (virtual updates דרך loadChatSession) ואירוע SSE
 * ייעודי (agent_update) לבעל הפנייה בלבד. DB זמני מבודד; בלי AI. הצד של ה-HTTP (index.ts) מנתב ל-
 * loadChatSession ול-teamSseFrame — שתיהן נבדקות ישירות כאן.
 */

import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/db.js";
import { resolveUserByKey, type IdentifiedUser } from "../../src/identity/index.js";
import { subscribeNotifications, type BusNotification } from "../../src/ops/notificationBus.js";
import { handleTeamRequest, teamSseFrame, type TeamResponse } from "../../src/server/teamApi.js";
import { loadChatSession } from "../../src/server/chatSession.js";
import { deleteTeamMessage, editTeamMessage, sendDirectTeamMessage, sendTeamMessage } from "../../src/ops/teamDelivery.js";
import { claimForSending, completeSend, createDraft, outreachClientMessageId } from "../../src/db/repositories/agentOutreach.js";
import { appendChatTurn, latestSessionId, listSessions } from "../../src/db/repositories/chatHistory.js";
import { listThreads, unreadTotal } from "../../src/db/repositories/teamMessages.js";

const u = (key: string): IdentifiedUser => resolveUserByKey(key)!;
const DOV = u("dov");
const EITAN = u("eitan");
const RUCHAMA = u("ruchama");
const MOTI = u("moti");

function clean(): void {
  db.exec(`DELETE FROM agent_outreach`);
  db.exec(`DELETE FROM team_messages`);
  db.exec(`DELETE FROM team_thread_members`);
  db.exec(`DELETE FROM team_threads`);
  db.exec(`DELETE FROM chat_messages`);
}

/** פנייה שנשלחה בפועל בשם `from` אל `to` משיחת הסוכן `session`. */
function sentOutreach(from: IdentifiedUser, to: IdentifiedUser, session: string, body = "מה המצב?") {
  const o = createDraft({ userKey: from.key, sessionId: session, recipientKey: to.key, body, createdTurn: `t-${Math.random()}`, expiresAt: new Date(Date.now() + 600_000) });
  expect(claimForSending(o.id, from.key, session)).toBe(true);
  const sent = sendDirectTeamMessage(from.key, to.key, o.body, outreachClientMessageId(o.id));
  expect(completeSend(o.id, from.key, sent.message.id, sent.threadId)).toBe("ok");
  return { id: o.id, threadId: sent.threadId, messageId: sent.message.id };
}

/** מדמה את /api/events לכל משתמש: מה שהיה נכתב לו (פריימים) + כל אירועי ה-bus הגולמיים. */
function listen(keys: string[]) {
  const frames: Record<string, string[]> = Object.fromEntries(keys.map((k) => [k, []]));
  const raw: BusNotification[] = [];
  const unsubs = [
    subscribeNotifications((ev) => raw.push(ev)),
    ...keys.map((k) =>
      subscribeNotifications((ev) => {
        const f = teamSseFrame(ev, k);
        if (typeof f === "string") frames[k]!.push(f);
      }),
    ),
  ];
  const agent = (k: string) =>
    frames[k]!
      .filter((f) => f.startsWith("event: agent_update"))
      .map((f) => JSON.parse(f.split("data: ")[1]!.trim()) as Record<string, unknown>);
  return { frames, raw, agent, stop: () => unsubs.forEach((x) => x()) };
}

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
let n = 0;
const cid = () => `ar-${++n}`;
let stop: (() => void) | null = null;

beforeEach(() => {
  stop?.();
  stop = null;
  clean();
});

describe("זיהוי תשובה וטעינת שיחה", () => {
  it("1+8: תשובה מפורשת מופיעה ב-teamUpdates של שיחת הסוכן, מקושרת למזהה ההודעה", () => {
    const o = sentOutreach(DOV, EITAN, "s1", "איפה התכניות?");
    const reply = sendTeamMessage(EITAN.key, o.threadId, "שלחתי הבוקר", cid(), o.messageId).message;
    const { teamUpdates, messages } = loadChatSession(DOV.key, "s1");
    expect(messages).toEqual([]);
    expect(teamUpdates).toHaveLength(1);
    expect(teamUpdates[0]).toMatchObject({
      messageId: reply.id,
      outreachId: o.id,
      threadId: o.threadId,
      fromKey: "eitan",
      fromName: "איתן ברמן",
      outreachBody: "איפה התכניות?",
      body: "שלחתי הבוקר",
      deleted: false,
      edited: false,
    });
  });

  it("2: הודעה רגילה (בלי השב) אינה עדכון", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const f = listen([DOV.key, EITAN.key]);
    stop = f.stop;
    sendTeamMessage(EITAN.key, o.threadId, "הודעה חדשה, לא תשובה", cid());
    expect(loadChatSession(DOV.key, "s1").teamUpdates).toEqual([]);
    expect(f.agent(DOV.key)).toEqual([]);
  });

  it("3+כמה פניות: כל תשובה משויכת לפנייה שלה בלבד; כמה תשובות לאותה פנייה נשמרות כולן", () => {
    const a = sentOutreach(DOV, EITAN, "s1", "פנייה א");
    const b = sentOutreach(DOV, EITAN, "s1", "פנייה ב");
    const rb = sendTeamMessage(EITAN.key, b.threadId, "ל-ב", cid(), b.messageId).message;
    const ra1 = sendTeamMessage(EITAN.key, a.threadId, "ל-א ראשונה", cid(), a.messageId).message;
    const ra2 = sendTeamMessage(EITAN.key, a.threadId, "ל-א שנייה", cid(), a.messageId).message;
    const ups = loadChatSession(DOV.key, "s1").teamUpdates;
    expect(ups.map((x) => [x.outreachId, x.messageId])).toEqual([
      [b.id, rb.id],
      [a.id, ra1.id],
      [a.id, ra2.id],
    ]);
    expect(ups.map((x) => x.messageId)).toEqual([...new Set(ups.map((x) => x.messageId))]); // בלי כפילויות
    // תגובה לתשובה (לא להודעת הפנייה) אינה עדכון
    sendTeamMessage(DOV.key, a.threadId, "תודה", cid(), ra1.id);
    sendTeamMessage(EITAN.key, a.threadId, "על התודה", cid(), ra1.id);
    expect(loadChatSession(DOV.key, "s1").teamUpdates).toHaveLength(3);
  });

  it("after מחזיר רק עדכונים חדשים; טעינה חוזרת זהה (אין כפילות)", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const r1 = sendTeamMessage(EITAN.key, o.threadId, "1", cid(), o.messageId).message;
    const r2 = sendTeamMessage(EITAN.key, o.threadId, "2", cid(), o.messageId).message;
    expect(loadChatSession(DOV.key, "s1", r1.id).teamUpdates.map((x) => x.messageId)).toEqual([r2.id]);
    expect(loadChatSession(DOV.key, "s1")).toEqual(loadChatSession(DOV.key, "s1"));
  });

  it("9: בידוד בין שיחות סוכן ובין משתמשים; legacy ללא עדכונים", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    sendTeamMessage(EITAN.key, o.threadId, "תשובה", cid(), o.messageId);
    expect(loadChatSession(DOV.key, "s1").teamUpdates).toHaveLength(1);
    expect(loadChatSession(DOV.key, "s2").teamUpdates).toEqual([]);
    expect(loadChatSession(DOV.key, null).teamUpdates).toEqual([]);
    expect(loadChatSession(DOV.key, "legacy").teamUpdates).toEqual([]);
    for (const other of [EITAN, RUCHAMA, MOTI]) expect(loadChatSession(other.key, "s1").teamUpdates).toEqual([]);
  });

  it("תשובה של משתמש שאינו הנמען אינה נספרת (גם אם reply_to_id נכון)", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    // השולח עצמו עונה להודעת הפנייה שלו — לא עדכון
    sendTeamMessage(DOV.key, o.threadId, "הוספה שלי", cid(), o.messageId);
    expect(loadChatSession(DOV.key, "s1").teamUpdates).toEqual([]);
    // משתמש זר לא יכול בכלל להגיב בשיחה
    expect(() => sendTeamMessage(RUCHAMA.key, o.threadId, "חדירה", cid(), o.messageId)).toThrow();
    expect(loadChatSession(DOV.key, "s1").teamUpdates).toEqual([]);
  });

  it("10: עריכה ומחיקה של התשובה משתקפות בטעינה", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const reply = sendTeamMessage(EITAN.key, o.threadId, "נוסח ראשון", cid(), o.messageId).message;
    editTeamMessage(EITAN.key, o.threadId, reply.id, "נוסח מתוקן");
    expect(loadChatSession(DOV.key, "s1").teamUpdates[0]).toMatchObject({ body: "נוסח מתוקן", deleted: false, edited: true });
    deleteTeamMessage(EITAN.key, o.threadId, reply.id);
    const [after] = loadChatSession(DOV.key, "s1").teamUpdates;
    expect(after).toMatchObject({ messageId: reply.id, deleted: true, body: "הודעה נמחקה" });
    expect(JSON.stringify(after)).not.toContain("נוסח מתוקן");
    expect(loadChatSession(DOV.key, "s1").teamUpdates).toHaveLength(1);
  });

  it("לא משנה את chat_messages / latestSessionId / listSessions", () => {
    appendChatTurn(DOV.key, "s-old", "תשאל את איתן", "הכנתי", []);
    appendChatTurn(DOV.key, "s-new", "בוקר טוב", "בוקר טוב", []);
    const o = sentOutreach(DOV, EITAN, "s-old");
    const chatBefore = count("chat_messages");
    const latestBefore = latestSessionId(DOV.key);
    const sessionsBefore = JSON.stringify(listSessions(DOV.key));
    const reply = sendTeamMessage(EITAN.key, o.threadId, "תשובה", cid(), o.messageId).message;
    editTeamMessage(EITAN.key, o.threadId, reply.id, "תשובה מתוקנת");
    expect(count("chat_messages")).toBe(chatBefore);
    expect(latestSessionId(DOV.key)).toBe(latestBefore);
    expect(latestBefore).toBe("s-new");
    expect(JSON.stringify(listSessions(DOV.key))).toBe(sessionsBefore);
  });

  it("המשתמש לא מחובר בזמן התשובה: העדכון נשמר ב-DB ונטען בכניסה הבאה", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    // אין מאזינים בכלל (אין חיבור SSE)
    const reply = sendTeamMessage(EITAN.key, o.threadId, "תשובה בזמן שדוב לא מחובר", cid(), o.messageId).message;
    expect(loadChatSession(DOV.key, "s1").teamUpdates.map((x) => x.messageId)).toEqual([reply.id]);
  });
});

describe("SSE", () => {
  it("4+5: רק בעל הפנייה מקבל agent_update (מזהים בלבד), ואף אירוע לא מנותב כ-notification", () => {
    const o = sentOutreach(DOV, EITAN, "s1", "טקסט פנייה סודי");
    const f = listen([DOV.key, EITAN.key, RUCHAMA.key, MOTI.key]);
    stop = f.stop;
    const reply = sendTeamMessage(EITAN.key, o.threadId, "תוכן התשובה הסודי", cid(), o.messageId).message;

    expect(f.agent(DOV.key)).toEqual([
      { type: "reply", change: "new", sessionId: "s1", outreachId: o.id, threadId: o.threadId, messageId: reply.id, rev: reply.rev },
    ]);
    for (const other of [EITAN, RUCHAMA, MOTI]) expect(f.agent(other.key)).toEqual([]);
    // אין תוכן בפריים
    const all = JSON.stringify(f.frames);
    expect(all).not.toContain("תוכן התשובה הסודי");
    expect(all).not.toContain("טקסט פנייה סודי");
    // כל אירוע ב-bus נתפס ע"י teamSseFrame (מחרוזת/null) — כלומר לא יגיע לענף "notification" של /api/events
    expect(f.raw.length).toBeGreaterThan(0);
    for (const ev of f.raw) {
      for (const k of [DOV.key, EITAN.key, RUCHAMA.key, MOTI.key]) expect(teamSseFrame(ev, k), `${ev.kind} → ${k}`).not.toBeUndefined();
    }
    expect(f.raw.filter((e) => e.kind.startsWith("agent_outreach_"))).toHaveLength(1);
  });

  it("אירועי team_message_* הקיימים נשארים זהים (לשני המשתתפים), ועריכה/מחיקה מפרסמות גם agent_update", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const f = listen([DOV.key, EITAN.key]);
    stop = f.stop;
    const reply = sendTeamMessage(EITAN.key, o.threadId, "תשובה", cid(), o.messageId).message;
    editTeamMessage(EITAN.key, o.threadId, reply.id, "מתוקן");
    deleteTeamMessage(EITAN.key, o.threadId, reply.id);
    for (const k of [DOV.key, EITAN.key]) {
      const team = f.frames[k]!.filter((x) => x.startsWith("event: team")).map((x) => JSON.parse(x.split("data: ")[1]!.trim()).type);
      expect(team).toEqual(["new", "edited", "deleted"]);
    }
    expect(f.agent(DOV.key).map((e) => e.change)).toEqual(["new", "edited", "deleted"]);
    expect(f.agent(EITAN.key)).toEqual([]);
  });

  it("הודעה רגילה, תשובה לפנייה אחרת של אחרים, או כפילות (duplicate) — לא מפרסמות עדכון", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const f = listen([DOV.key]);
    stop = f.stop;
    sendTeamMessage(EITAN.key, o.threadId, "רגילה", cid());
    const id = cid();
    sendTeamMessage(EITAN.key, o.threadId, "תשובה", id, o.messageId);
    sendTeamMessage(EITAN.key, o.threadId, "תשובה", id, o.messageId); // retry — duplicate
    expect(f.agent(DOV.key)).toHaveLength(1);
    // שיחה אחרת לגמרי (רוחמה↔איתן) שאינה קשורה לפנייה
    const other = sendDirectTeamMessage(RUCHAMA.key, EITAN.key, "הי", cid());
    sendTeamMessage(EITAN.key, other.threadId, "ענה", cid(), other.message.id);
    expect(f.agent(DOV.key)).toHaveLength(1);
  });

  it("שני מכשירים של בעל הפנייה: שני המאזינים מקבלים אותו אירוע, והשליפה זהה (ללא כפילות)", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const device1 = listen([DOV.key]);
    const device2 = listen([DOV.key]);
    stop = () => {
      device1.stop();
      device2.stop();
    };
    const reply = sendTeamMessage(EITAN.key, o.threadId, "תשובה", cid(), o.messageId).message;
    expect(device1.agent(DOV.key)).toEqual(device2.agent(DOV.key));
    expect(device1.agent(DOV.key)).toHaveLength(1);
    expect(loadChatSession(DOV.key, "s1").teamUpdates.map((x) => x.messageId)).toEqual([reply.id]);
  });

  it("ניתוק וחיבור מחדש: אירועים שהוחמצו לא אובדים — השליפה מה-DB משלימה", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const r1 = sendTeamMessage(EITAN.key, o.threadId, "לפני ניתוק", cid(), o.messageId).message;
    const known = loadChatSession(DOV.key, "s1").teamUpdates.map((x) => x.messageId); // מצב הלקוח לפני הניתוק
    expect(known).toEqual([r1.id]);
    // בזמן הניתוק (אין מאזינים) מגיעות עוד תשובות
    const r2 = sendTeamMessage(EITAN.key, o.threadId, "בזמן ניתוק", cid(), o.messageId).message;
    const r3 = sendTeamMessage(EITAN.key, o.threadId, "עוד אחת", cid(), o.messageId).message;
    // חיבור מחדש → הלקוח שולף עם after=האחרון שהכיר
    expect(loadChatSession(DOV.key, "s1", r1.id).teamUpdates.map((x) => x.messageId)).toEqual([r2.id, r3.id]);
  });
});

describe("תווית 'פנייה מהסוכן' (viaAgent) ב-API של הודעות צוות", () => {
  const list = async (user: IdentifiedUser, threadId: number) =>
    ((await handleTeamRequest({ method: "GET", path: `/api/team/threads/${threadId}/messages`, query: new URLSearchParams(), readBody: async () => ({}), user })).body as { messages: { id: number; viaAgent: boolean; senderKey: string }[] }).messages;

  it("true רק על הודעה שנשלחה דרך פנייה (sent); הודעה רגילה ותשובה — false; שני המשתתפים רואים אותו דבר", async () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const manual = sendTeamMessage(DOV.key, o.threadId, "הודעה רגילה שלי", cid()).message;
    const reply = sendTeamMessage(EITAN.key, o.threadId, "תשובה", cid(), o.messageId).message;
    for (const viewer of [DOV, EITAN]) {
      const msgs = await list(viewer, o.threadId);
      expect(Object.fromEntries(msgs.map((m) => [m.id, m.viaAgent])), viewer.key).toEqual({ [o.messageId]: true, [manual.id]: false, [reply.id]: false });
      expect(msgs.find((m) => m.id === o.messageId)!.senderKey).toBe("dov"); // הזהות לא משתנה
    }
  });

  it("פנייה שנתקעה ב-sending (ההודעה נשלחה אך לא תועדה) אינה מסומנת; הסימון נשען רק על agent_outreach", () => {
    const o = createDraft({ userKey: DOV.key, sessionId: "s1", recipientKey: EITAN.key, body: "x", createdTurn: "t", expiresAt: new Date(Date.now() + 600_000) });
    claimForSending(o.id, DOV.key, "s1");
    const sent = sendDirectTeamMessage(DOV.key, EITAN.key, o.body, outreachClientMessageId(o.id));
    expect(sent.message.viaAgent).toBe(false);
    // clientMessageId שנראה כמו של פנייה, בלי רשומת פנייה, לא מזייף תווית
    const faked = sendDirectTeamMessage(EITAN.key, DOV.key, "מזויף", "ao:ao_fake");
    expect(faked.message.viaAgent).toBe(false);
  });

  it("משתמש שאינו משתתף לא רואה כלום (404) ולכן לא רואה גם את הסימון", async () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const r = await handleTeamRequest({ method: "GET", path: `/api/team/threads/${o.threadId}/messages`, query: new URLSearchParams(), readBody: async () => ({}), user: RUCHAMA });
    expect(r.status).toBe(404);
  });
});

describe("ui.html — אילוצים סטטיים של שלב 5", () => {
  const ui = fs.readFileSync(new URL("../../src/server/ui.html", import.meta.url), "utf-8");
  it("עדכוני צוות לא נכנסים להקשר המודל ולא ל-state.thread", () => {
    expect(ui).toMatch(/return state\.thread\.filter\(m => m\.role === "user" \|\| m\.role === "assistant"\)/);
    expect(ui).not.toMatch(/state\.thread\.push\([^)]*team/i);
    expect(ui).not.toMatch(/\/api\/chat"[^}]*teamUpdates/);
  });
  it("מאזין agent_update קיים, ונפרד מ-notification ומהפעמון", () => {
    expect(ui).toMatch(/es\.addEventListener\("agent_update"/);
    const handler = ui.slice(ui.indexOf("function onAgentUpdateEvent"), ui.indexOf("function resyncAgentUpdates"));
    expect(handler).not.toMatch(/loadNotifications|addNudge|onLiveNotification|\/api\/notifications/);
  });
  it("הכפתור 'פתח בהודעות צוות' לא קורא ל-read ישירות (סימון נקרא רק דרך openThread)", () => {
    const fn = ui.slice(ui.indexOf("async function openUpdateInTeam"), ui.indexOf("function onAgentUpdateEvent"));
    expect(fn).not.toMatch(/\/read|markRead/);
    expect(fn).toMatch(/openThread\(u\.threadId\)/);
  });
});

describe("התראות ו-unread", () => {
  it("6+7: לא נוצרת שורה ב-notifications; מוני unread והסימון נקרא ללא שינוי; טעינת שיחה לא מסמנת נקרא", () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const notifBefore = count("notifications");
    sendTeamMessage(EITAN.key, o.threadId, "תשובה", cid(), o.messageId);
    sendTeamMessage(EITAN.key, o.threadId, "עוד תשובה", cid(), o.messageId);
    loadChatSession(DOV.key, "s1");
    loadChatSession(DOV.key, "s1");
    expect(count("notifications")).toBe(notifBefore);
    expect(unreadTotal(DOV.key)).toBe(2); // הודעות צוות רגילות שלא נקראו — כמו תמיד
    expect(unreadTotal(EITAN.key)).toBe(1); // הפנייה עצמה
    const th = listThreads(DOV.key).find((t) => t.id === o.threadId)!;
    expect(th.unread).toBe(2);
    expect(th.lastReadMessageId).toBe(0);
  });

  it("תאימות ל-API: POST הודעה דרך handleTeamRequest מפיק את אותו עדכון", async () => {
    const o = sentOutreach(DOV, EITAN, "s1");
    const f = listen([DOV.key]);
    stop = f.stop;
    const r: TeamResponse = await handleTeamRequest({
      method: "POST",
      path: `/api/team/threads/${o.threadId}/messages`,
      query: new URLSearchParams(),
      readBody: async () => ({ body: "דרך ה-API", clientMessageId: cid(), replyTo: o.messageId }),
      user: EITAN,
    });
    expect(r.status).toBe(201);
    expect(f.agent(DOV.key)).toHaveLength(1);
    expect(loadChatSession(DOV.key, "s1").teamUpdates[0]).toMatchObject({ body: "דרך ה-API" });
  });
});
