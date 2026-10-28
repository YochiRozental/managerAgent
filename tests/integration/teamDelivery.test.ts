/**
 * הודעות צוות — מסלול שליחה/פרסום משותף (ops/teamDelivery.ts), שלב 2 של פניות הסוכן. DB זמני מבודד בלבד.
 * מוכיח: ה-API הקיים והמסלול הישיר משתמשים באותו מנגנון ומפיקים אירועים זהים; אידמפוטנטיות בלי אירוע
 * מטעה; אירועים רק לחברי השיחה; אפס פעמון/notifications; unread/reply/edit/delete ללא שינוי; ותאימות
 * ל-agent_outreach (התאוששות מ-sending עם ao:<id>).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/db.js";
import { resolveUserByKey, type IdentifiedUser } from "../../src/identity/index.js";
import { subscribeNotifications, type BusNotification } from "../../src/ops/notificationBus.js";
import { handleTeamRequest, teamSseFrame, type TeamResponse } from "../../src/server/teamApi.js";
import {
  TEAM_EVENT_KIND_PREFIX,
  deleteTeamMessage,
  editTeamMessage,
  sendDirectTeamMessage,
  sendTeamMessage,
} from "../../src/ops/teamDelivery.js";
import { TeamMessageError, listMessages, listThreads, openDm, unreadTotal } from "../../src/db/repositories/teamMessages.js";
import {
  claimForSending,
  completeSend,
  createDraft,
  getOutreach,
  listRepliesForSession,
  listSending,
  outreachClientMessageId,
} from "../../src/db/repositories/agentOutreach.js";

const u = (key: string): IdentifiedUser => resolveUserByKey(key)!;
const A = u("dov");
const B = u("eitan");
const C = u("ruchama");
const OWNER = u("moti");

function clean(): void {
  db.exec(`DELETE FROM agent_outreach`);
  db.exec(`DELETE FROM team_messages`);
  db.exec(`DELETE FROM team_thread_members`);
  db.exec(`DELETE FROM team_threads`);
}

async function call(user: IdentifiedUser | null, method: string, fullPath: string, body: Record<string, unknown> = {}): Promise<TeamResponse> {
  const url = new URL(fullPath, "http://x");
  return handleTeamRequest({ method, path: url.pathname, query: url.searchParams, readBody: async () => body, user });
}

/** מאזין כמו /api/events: פריימי team לכל משתמש + כל אירועי ה-bus הגולמיים. */
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
  const parsed = (k: string) => frames[k]!.map((f) => JSON.parse(f.split("data: ")[1]!.trim()) as Record<string, unknown>);
  return { frames, raw, parsed, stop: () => unsubs.forEach((x) => x()) };
}

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
let n = 0;
const cid = () => `td-${++n}`;
let stop: (() => void) | null = null;

beforeEach(() => {
  stop?.();
  stop = null;
  clean();
});

describe("שליחה דרך ה-API הקיים", () => {
  it("201 + אירוע new לשני המשתתפים, כשה-API משתמש במסלול המשותף", async () => {
    const t = (await call(A, "POST", "/api/team/threads", { with: B.key })).body as { threadId: number };
    const l = listen([A.key, B.key, C.key]);
    stop = l.stop;
    const r = await call(A, "POST", `/api/team/threads/${t.threadId}/messages`, { body: "שלום", clientMessageId: cid() });
    expect(r.status).toBe(201);
    const msg = (r.body as { message: { id: number; rev: number } }).message;
    for (const k of [A.key, B.key]) {
      expect(l.parsed(k)).toEqual([{ type: "new", threadId: t.threadId, messageId: msg.id, rev: msg.rev, senderKey: A.key }]);
    }
    expect(l.parsed(C.key)).toEqual([]);
  });

  it("שליחה חוזרת באותו clientMessageId: 200, duplicate, בלי אירוע שני", async () => {
    const t = (await call(A, "POST", "/api/team/threads", { with: B.key })).body as { threadId: number };
    const id = cid();
    await call(A, "POST", `/api/team/threads/${t.threadId}/messages`, { body: "פעם אחת", clientMessageId: id });
    const l = listen([A.key, B.key]);
    stop = l.stop;
    const again = await call(A, "POST", `/api/team/threads/${t.threadId}/messages`, { body: "פעם אחת", clientMessageId: id });
    expect(again.status).toBe(200);
    expect((again.body as { duplicate: boolean }).duplicate).toBe(true);
    expect(l.raw).toEqual([]);
    expect(listMessages(A.key, t.threadId).messages).toHaveLength(1);
  });
});

describe("שליחה דרך ה-helper המשותף", () => {
  it("sendDirectTeamMessage פותח DM, שולח בשם המשתמש ומפרסם new לשני הצדדים בלבד", () => {
    const l = listen([A.key, B.key, C.key, OWNER.key]);
    stop = l.stop;
    const r = sendDirectTeamMessage(A.key, B.key, "  פנייה  ", "ao:test1");
    expect(r.duplicate).toBe(false);
    expect(r.message).toMatchObject({ senderKey: A.key, body: "פנייה", threadId: r.threadId });
    for (const k of [A.key, B.key]) {
      expect(l.parsed(k)).toEqual([{ type: "new", threadId: r.threadId, messageId: r.message.id, rev: r.message.rev, senderKey: A.key }]);
    }
    expect(l.parsed(C.key)).toEqual([]);
    expect(l.parsed(OWNER.key)).toEqual([]); // גם owner לא משתתף = לא מקבל
    expect(unreadTotal(B.key)).toBe(1);
    expect(unreadTotal(A.key)).toBe(0);
  });

  it("אותו DM משותף לשני המסלולים (API ו-helper) — שיחה אחת", async () => {
    const viaApi = ((await call(A, "POST", "/api/team/threads", { with: B.key })).body as { threadId: number }).threadId;
    const viaHelper = sendDirectTeamMessage(B.key, A.key, "הי", cid()).threadId;
    expect(viaHelper).toBe(viaApi);
  });

  it("זהות השולח היא תמיד me; הרשאות נאכפות (שיחה זרה, משתמש לא קיים, עצמי) בלי אירוע", () => {
    const { threadId } = openDm(A.key, B.key);
    const l = listen([A.key, B.key, C.key]);
    stop = l.stop;
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as TeamMessageError).code;
      }
      return "none";
    };
    expect(codeOf(() => sendTeamMessage(C.key, threadId, "חדירה", cid()))).toBe("not_found");
    expect(codeOf(() => sendTeamMessage(OWNER.key, threadId, "חדירה", cid()))).toBe("not_found");
    expect(codeOf(() => sendDirectTeamMessage(A.key, "nobody", "x", cid()))).toBe("invalid");
    expect(codeOf(() => sendDirectTeamMessage(A.key, A.key, "x", cid()))).toBe("invalid");
    expect(codeOf(() => sendDirectTeamMessage(A.key, B.key, "   ", cid()))).toBe("invalid");
    expect(codeOf(() => sendDirectTeamMessage(A.key, B.key, "x", ""))).toBe("invalid");
    expect(l.raw).toEqual([]);
    expect(listMessages(A.key, threadId).messages).toEqual([]);
  });

  it("בידוד: אותו clientMessageId משולחים שונים הם הודעות נפרדות", () => {
    const a = sendDirectTeamMessage(A.key, B.key, "מדב", "same");
    const b = sendDirectTeamMessage(B.key, A.key, "מאיתן", "same");
    expect(a.message.id).not.toBe(b.message.id);
    expect(b.duplicate).toBe(false);
  });
});

describe("אידמפוטנטיות והתאוששות מ-sending", () => {
  it("שליחה חוזרת עם אותו ao:<id> מחזירה את ההודעה הקיימת בלי כפילות ובלי אירוע", () => {
    const first = sendDirectTeamMessage(A.key, B.key, "פנייה", "ao:ao_x1");
    const l = listen([A.key, B.key]);
    stop = l.stop;
    const retry = sendDirectTeamMessage(A.key, B.key, "פנייה", "ao:ao_x1");
    expect(retry.duplicate).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.threadId).toBe(first.threadId);
    expect(l.raw).toEqual([]);
    expect(count("team_messages")).toBe(1);
    expect(unreadTotal(B.key)).toBe(1);
  });

  it("פנייה שנתקעה ב-sending (קריסה אחרי השליחה) משלימה עם אותה הודעה", () => {
    const o = createDraft({ userKey: A.key, sessionId: "s1", recipientKey: B.key, body: "פנייה", createdTurn: "t1", expiresAt: new Date(Date.now() + 600_000) });
    expect(claimForSending(o.id, A.key, "s1")).toBe(true);
    const sent = sendDirectTeamMessage(A.key, B.key, o.body, outreachClientMessageId(o.id)); // ...וקריסה לפני completeSend
    expect(listSending(A.key).map((x) => x.id)).toEqual([o.id]);

    const l = listen([A.key, B.key]);
    stop = l.stop;
    const recovered = sendDirectTeamMessage(A.key, B.key, o.body, outreachClientMessageId(o.id));
    expect(recovered.duplicate).toBe(true);
    expect(recovered.message.id).toBe(sent.message.id);
    expect(completeSend(o.id, A.key, recovered.message.id, recovered.threadId)).toBe("ok");
    expect(getOutreach(o.id, A.key)).toMatchObject({ status: "sent", teamMessageId: sent.message.id, threadId: sent.threadId });
    expect(l.raw).toEqual([]); // אין אירוע מטעה בהתאוששות
    expect(count("team_messages")).toBe(1);
  });

  it("פנייה שנתקעה לפני השליחה: השליחה הראשונה בהתאוששות כן מפרסמת אירוע (הודעה חדשה)", () => {
    const o = createDraft({ userKey: A.key, sessionId: "s1", recipientKey: B.key, body: "פנייה", createdTurn: "t1", expiresAt: new Date(Date.now() + 600_000) });
    claimForSending(o.id, A.key, "s1");
    const l = listen([B.key]);
    stop = l.stop;
    const r = sendDirectTeamMessage(A.key, B.key, o.body, outreachClientMessageId(o.id));
    expect(r.duplicate).toBe(false);
    expect(l.parsed(B.key)).toHaveLength(1);
  });
});

describe("פעמון והתראות", () => {
  it("אין שורות ב-notifications ואין אירוע שאינו team_message_*, לכל פעולה (שליחה/תגובה/עריכה/מחיקה)", async () => {
    const before = count("notifications");
    const l = listen([A.key, B.key]);
    stop = l.stop;
    const sent = sendDirectTeamMessage(A.key, B.key, "פנייה", cid());
    const reply = sendTeamMessage(B.key, sent.threadId, "תשובה", cid(), sent.message.id);
    editTeamMessage(B.key, sent.threadId, reply.message.id, "תשובה מתוקנת");
    deleteTeamMessage(B.key, sent.threadId, reply.message.id);
    await call(A, "POST", `/api/team/threads/${sent.threadId}/messages`, { body: "דרך API", clientMessageId: cid() });
    expect(count("notifications")).toBe(before);
    expect(l.raw.length).toBeGreaterThan(0);
    expect(l.raw.every((e) => e.kind.startsWith(TEAM_EVENT_KIND_PREFIX))).toBe(true);
    // כל אירוע נתפס ע"י teamSseFrame (מחרוזת/ null), כלומר לא יגיע לענף ה"notification" של /api/events
    expect(l.raw.every((e) => teamSseFrame(e, A.key) !== undefined)).toBe(true);
  });
});

describe("unread, reply, edit, delete ללא שינוי", () => {
  it("רצף מלא: תגובה, עריכה, מחיקה, מוני unread, ואירועי edited/deleted לשני הצדדים", () => {
    const sent = sendDirectTeamMessage(A.key, B.key, "פנייה", cid());
    const l = listen([A.key, B.key, C.key]);
    stop = l.stop;
    const reply = sendTeamMessage(B.key, sent.threadId, "תשובה", cid(), sent.message.id);
    expect(reply.message.replyTo).toMatchObject({ id: sent.message.id, senderKey: A.key });
    expect(unreadTotal(A.key)).toBe(1);
    expect(unreadTotal(B.key)).toBe(1);

    const edited = editTeamMessage(B.key, sent.threadId, reply.message.id, "תשובה מתוקנת");
    expect(edited.body).toBe("תשובה מתוקנת");
    expect(edited.rev).toBeGreaterThan(reply.message.rev);
    const deleted = deleteTeamMessage(B.key, sent.threadId, reply.message.id);
    expect(deleted.deleted).toBe(true);
    expect(unreadTotal(A.key)).toBe(0); // מחוקה לא נספרת — כמו קודם

    expect(l.parsed(A.key).map((e) => e.type)).toEqual(["new", "edited", "deleted"]);
    expect(l.parsed(B.key).map((e) => e.type)).toEqual(["new", "edited", "deleted"]);
    expect(l.parsed(C.key)).toEqual([]);
    expect(listThreads(A.key)[0]!.lastReadMessageId).toBe(0); // שום סימון נקרא אוטומטי
  });

  it("עריכה/מחיקה של הודעת אחר נדחות ללא אירוע", () => {
    const sent = sendDirectTeamMessage(A.key, B.key, "פנייה", cid());
    const l = listen([A.key, B.key]);
    stop = l.stop;
    expect(() => editTeamMessage(B.key, sent.threadId, sent.message.id, "חטיפה")).toThrow(TeamMessageError);
    expect(() => deleteTeamMessage(B.key, sent.threadId, sent.message.id)).toThrow(TeamMessageError);
    expect(() => editTeamMessage(C.key, sent.threadId, sent.message.id, "זר")).toThrow(TeamMessageError);
    expect(l.raw).toEqual([]);
  });
});

describe("תאימות לשלב 1 (agent_outreach)", () => {
  it("פנייה שנשלחה דרך ה-helper מזוהה, ותשובה מפורשת מזוהה; הודעה רגילה לא", () => {
    const o = createDraft({ userKey: A.key, sessionId: "s1", recipientKey: B.key, body: "מה קורה עם התכניות?", createdTurn: "t1", expiresAt: new Date(Date.now() + 600_000) });
    expect(claimForSending(o.id, A.key, "s1")).toBe(true);
    const sent = sendDirectTeamMessage(A.key, B.key, o.body, outreachClientMessageId(o.id));
    expect(completeSend(o.id, A.key, sent.message.id, sent.threadId)).toBe("ok");

    sendTeamMessage(B.key, sent.threadId, "הודעה רגילה", cid());
    expect(listRepliesForSession(A.key, "s1")).toEqual([]);
    const reply = sendTeamMessage(B.key, sent.threadId, "מצורף", cid(), sent.message.id);
    expect(listRepliesForSession(A.key, "s1").map((r) => r.messageId)).toEqual([reply.message.id]);
  });
});
