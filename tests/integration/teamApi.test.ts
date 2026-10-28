/**
 * הודעות צוות (שלב 2) — API + SSE + סנכרון אחרי ניתוק. קורא ישירות ל-handleTeamRequest (בלי שרת HTTP)
 * ול-teamSseFrame (אותה פונקציה ש-/api/events משתמש בה), על DB זמני מבודד בלבד (tests/setup).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/db.js";
import { resolveUserByKey, type IdentifiedUser } from "../../src/identity/index.js";
import { addNotification, listUnseenNotifications } from "../../src/db/repositories/notifications.js";
import { publishNotificationLive, subscribeNotifications, type BusNotification } from "../../src/ops/notificationBus.js";
import { handleTeamRequest, teamSseFrame, type TeamResponse } from "../../src/server/teamApi.js";
import { TEAM_MESSAGE_MAX } from "../../src/db/repositories/teamMessages.js";

const u = (key: string): IdentifiedUser => resolveUserByKey(key)!;
const A = u("dov");
const B = u("eitan");
const C = u("ruchama");
const OWNER = u("moti");
const ADMIN = u("yochi");

function clean(): void {
  db.exec(`DELETE FROM team_messages`);
  db.exec(`DELETE FROM team_thread_members`);
  db.exec(`DELETE FROM team_threads`);
}

async function call(
  user: IdentifiedUser | null,
  method: string,
  fullPath: string,
  body: Record<string, unknown> = {},
): Promise<TeamResponse> {
  const url = new URL(fullPath, "http://x");
  return handleTeamRequest({ method, path: url.pathname, query: url.searchParams, readBody: async () => body, user });
}

let n = 0;
const cid = () => `api-${++n}`;

/** מדמה את חיבורי ה-/api/events: לכל משתמש רשימת פריימים שהיו נכתבים לו. */
function listen(keys: string[]) {
  const frames: Record<string, string[]> = Object.fromEntries(keys.map((k) => [k, []]));
  const unsubs = keys.map((k) =>
    subscribeNotifications((ev) => {
      const f = teamSseFrame(ev, k);
      if (typeof f === "string") frames[k]!.push(f);
    }),
  );
  const parsed = (k: string) => frames[k]!.map((f) => JSON.parse(f.split("data: ")[1]!.trim()) as Record<string, unknown>);
  return { frames, parsed, stop: () => unsubs.forEach((x) => x()) };
}

async function dm(a = A, b = B): Promise<number> {
  const r = await call(a, "POST", "/api/team/threads", { with: b.key });
  return (r.body as { threadId: number }).threadId;
}
async function send(user: IdentifiedUser, t: number, text: string, extra: Record<string, unknown> = {}) {
  const r = await call(user, "POST", `/api/team/threads/${t}/messages`, { body: text, clientMessageId: cid(), ...extra });
  return r;
}
const msgOf = (r: TeamResponse) => (r.body as { message: { id: number; rev: number; body: string } }).message;

beforeEach(clean);

describe("1. אימות", () => {
  it("401 לכל endpoint בלי משתמש", async () => {
    const t = await dm();
    for (const [m, p] of [
      ["GET", "/api/team/directory"],
      ["GET", "/api/team/threads"],
      ["POST", "/api/team/threads"],
      ["GET", `/api/team/threads/${t}/messages`],
      ["POST", `/api/team/threads/${t}/messages`],
      ["PATCH", `/api/team/threads/${t}/messages/1`],
      ["DELETE", `/api/team/threads/${t}/messages/1`],
      ["POST", `/api/team/threads/${t}/read`],
      ["GET", "/api/team/unread"],
      ["GET", "/api/team/nope"],
    ] as const) {
      const r = await call(null, m, p);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });
});

describe("2. 404 זהה", () => {
  it("שיחה זרה = שיחה שלא קיימת (סטטוס וגוף זהים) בכל endpoint, גם מול owner/admin", async () => {
    const t = await dm();
    const m = msgOf(await send(A, t, "פרטי"));
    for (const outsider of [C, OWNER, ADMIN]) {
      const pairs: [string, string, Record<string, unknown>?][] = [
        ["GET", "/messages"],
        ["POST", "/messages", { body: "x", clientMessageId: "z" }],
        ["PATCH", `/messages/${m.id}`, { body: "x" }],
        ["DELETE", `/messages/${m.id}`],
        ["POST", "/read", { upTo: 1 }],
      ];
      for (const [method, suffix, body] of pairs) {
        const foreign = await call(outsider, method, `/api/team/threads/${t}${suffix}`, body ?? {});
        const missing = await call(outsider, method, `/api/team/threads/999999${suffix.replace(String(m.id), "999999")}`, body ?? {});
        expect(foreign.status, `${outsider.key} ${method}${suffix}`).toBe(404);
        expect(foreign).toEqual(missing);
      }
      expect((await call(outsider, "GET", "/api/team/threads")).body).toEqual({ threads: [] });
      expect((await call(outsider, "GET", "/api/team/unread")).body).toEqual({ unread: 0 });
    }
    // ודאי שלא השתנה כלום
    expect(msgOf(await send(A, t, "עוד"))).toBeTruthy();
    expect((await call(A, "GET", `/api/team/threads/${t}/messages`)).status).toBe(200);
  });

  it("הודעה משיחה אחרת (בנתיב של שיחה שאני חבר בה) → 404, בלי עריכה", async () => {
    const t1 = await dm(A, B);
    const t2 = await dm(A, C);
    const other = msgOf(await send(A, t2, "בשיחה אחרת"));
    expect((await call(A, "PATCH", `/api/team/threads/${t1}/messages/${other.id}`, { body: "x" })).status).toBe(404);
    expect((await call(A, "DELETE", `/api/team/threads/${t1}/messages/${other.id}`)).status).toBe(404);
    expect(msgOf(await call(A, "GET", `/api/team/threads/${t2}/messages`).then((r) => ({ status: 200, body: { message: (r.body as { messages: unknown[] }).messages[0] } })))).toMatchObject({ body: "בשיחה אחרת" });
  });
});

describe("3. פתיחת DM ושליחה", () => {
  it("directory בלי המשתמש עצמו; פתיחה משני הצדדים → אותה שיחה; שליחה וקריאה", async () => {
    const dir = (await call(A, "GET", "/api/team/directory")).body as { users: { key: string }[] };
    expect(dir.users.map((x) => x.key)).not.toContain(A.key);
    expect(dir.users.length).toBe(5);

    const first = await call(A, "POST", "/api/team/threads", { with: B.key });
    const second = await call(B, "POST", "/api/team/threads", { with: A.key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body as { threadId: number }).threadId).toBe((first.body as { threadId: number }).threadId);

    expect((await call(A, "POST", "/api/team/threads", { with: A.key })).status).toBe(400);
    expect((await call(A, "POST", "/api/team/threads", { with: "ghost" })).status).toBe(400);
    expect((await call(A, "POST", "/api/team/threads", {})).status).toBe(400);

    const t = (first.body as { threadId: number }).threadId;
    const sent = await send(A, t, "שלום");
    expect(sent.status).toBe(201);
    const list = (await call(B, "GET", `/api/team/threads/${t}/messages`)).body as { messages: { body: string; senderKey: string }[] };
    expect(list.messages).toMatchObject([{ body: "שלום", senderKey: A.key }]);
    expect((await call(B, "GET", "/api/team/unread")).body).toEqual({ unread: 1 });
    const read = await call(B, "POST", `/api/team/threads/${t}/read`, { upTo: msgOf(sent).id });
    expect(read.body).toMatchObject({ unread: 0, unreadTotal: 0 });
  });

  it("senderKey בגוף הבקשה מתעלמים ממנו", async () => {
    const t = await dm();
    const r = await send(A, t, "x", { senderKey: B.key, sender_key: B.key });
    expect((r.body as { message: { senderKey: string } }).message.senderKey).toBe(A.key);
  });

  it("clientMessageId חובה; ריק/חסר → 400", async () => {
    const t = await dm();
    expect((await call(A, "POST", `/api/team/threads/${t}/messages`, { body: "x" })).status).toBe(400);
    expect((await call(A, "POST", `/api/team/threads/${t}/messages`, { body: "x", clientMessageId: "" })).status).toBe(400);
  });
});

describe("4. שליחה כפולה", () => {
  it("אותו clientMessageId → הודעה אחת ואירוע SSE אחד", async () => {
    const t = await dm();
    const l = listen([A.key, B.key]);
    const body = { body: "פעם אחת", clientMessageId: "dup-1" };
    const r1 = await call(A, "POST", `/api/team/threads/${t}/messages`, body);
    const r2 = await call(A, "POST", `/api/team/threads/${t}/messages`, body);
    l.stop();
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect((r2.body as { duplicate: boolean }).duplicate).toBe(true);
    expect(msgOf(r2).id).toBe(msgOf(r1).id);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM team_messages`).get() as { c: number }).c).toBe(1);
    expect(l.parsed(A.key)).toHaveLength(1);
    expect(l.parsed(B.key)).toHaveLength(1);
  });
});

describe("5-6. עריכה ומחיקה", () => {
  it("רק השולח; הצד השני 403; צד שלישי 404", async () => {
    const t = await dm();
    const m = msgOf(await send(A, t, "שלי"));
    expect((await call(B, "PATCH", `/api/team/threads/${t}/messages/${m.id}`, { body: "שלך" })).status).toBe(403);
    expect((await call(B, "DELETE", `/api/team/threads/${t}/messages/${m.id}`)).status).toBe(403);
    expect((await call(OWNER, "PATCH", `/api/team/threads/${t}/messages/${m.id}`, { body: "x" })).status).toBe(404);
    const ok = await call(A, "PATCH", `/api/team/threads/${t}/messages/${m.id}`, { body: "ערוך" });
    expect(ok.status).toBe(200);
    expect(msgOf(ok).body).toBe("ערוך");
  });

  it("הודעה מחוקה: אין חשיפת תוכן באף תשובה (כולל ציטוט), ואי אפשר לערוך/למחוק שוב (409)", async () => {
    const t = await dm();
    const orig = msgOf(await send(A, t, "תוכן סודי למחיקה"));
    await send(B, t, "תגובה", { replyTo: orig.id });
    const del = await call(A, "DELETE", `/api/team/threads/${t}/messages/${orig.id}`);
    expect(del.status).toBe(200);
    expect(JSON.stringify(del.body)).not.toContain("סודי");
    expect((await call(A, "PATCH", `/api/team/threads/${t}/messages/${orig.id}`, { body: "חי" })).status).toBe(409);
    expect((await call(A, "DELETE", `/api/team/threads/${t}/messages/${orig.id}`)).status).toBe(409);

    for (const viewer of [A, B]) {
      const all = JSON.stringify([
        (await call(viewer, "GET", `/api/team/threads/${t}/messages`)).body,
        (await call(viewer, "GET", `/api/team/threads/${t}/messages?since=0`)).body,
        (await call(viewer, "GET", "/api/team/threads")).body,
      ]);
      expect(all).not.toContain("סודי");
    }
  });
});

describe("7. אורך", () => {
  it("4,000 מותר, 4,001 נדחה בשליחה ובעריכה (400)", async () => {
    const t = await dm();
    const ok = await send(A, t, "א".repeat(TEAM_MESSAGE_MAX));
    expect(ok.status).toBe(201);
    expect((await send(A, t, "א".repeat(TEAM_MESSAGE_MAX + 1))).status).toBe(400);
    expect((await call(A, "PATCH", `/api/team/threads/${t}/messages/${msgOf(ok).id}`, { body: "ב".repeat(TEAM_MESSAGE_MAX + 1) })).status).toBe(400);
    expect((await send(A, t, "   ")).status).toBe(400);
  });
});

describe("8-9. SSE", () => {
  it("רק למשתתפים; חדש/עריכה/מחיקה → אירועים נכונים, מזהים בלבד", async () => {
    const t = await dm(A, B);
    const l = listen([A.key, B.key, C.key, OWNER.key, ADMIN.key]);
    const m = msgOf(await send(A, t, "טקסט רגיש"));
    await call(A, "PATCH", `/api/team/threads/${t}/messages/${m.id}`, { body: "עריכה רגישה" });
    await call(A, "DELETE", `/api/team/threads/${t}/messages/${m.id}`);
    l.stop();

    for (const who of [A.key, B.key]) {
      expect(l.parsed(who).map((e) => e.type)).toEqual(["new", "edited", "deleted"]);
      expect(l.parsed(who).map((e) => e.rev)).toEqual([1, 2, 3]);
      expect(l.parsed(who).every((e) => e.threadId === t && e.messageId === m.id && e.senderKey === A.key)).toBe(true);
      for (const f of l.frames[who]!) {
        expect(f.startsWith("event: team\n")).toBe(true);
        expect(f).not.toContain("רגיש");
        expect(Object.keys(JSON.parse(f.split("data: ")[1]!.trim())).sort()).toEqual(["messageId", "messageId", "rev", "senderKey", "threadId", "type"].filter((x, i, a) => a.indexOf(x) === i).sort());
      }
    }
    for (const outsider of [C.key, OWNER.key, ADMIN.key]) expect(l.frames[outsider]).toEqual([]);
  });

  it("קינדים קיימים לא מושפעים: teamSseFrame מחזיר undefined והקוד הקיים ממשיך כרגיל", () => {
    const ev: BusNotification = { userKey: A.key, id: 1, kind: "approval_request", body: "x", findingKey: null, itemId: null, itemSource: null, context: null, createdAt: "t" };
    expect(teamSseFrame(ev, A.key)).toBeUndefined();
    expect(teamSseFrame({ ...ev, kind: "notification" }, A.key)).toBeUndefined();
    expect(teamSseFrame({ ...ev, kind: "nudge" }, B.key)).toBeUndefined();
    // אירוע צוות של משתמש אחר → null (לא נכתב), לא undefined (שלא ייפול לקוד הקיים)
    expect(teamSseFrame({ ...ev, kind: "team_message_new", context: { threadId: 1, messageId: 1, rev: 1, senderKey: "x" } }, B.key)).toBeNull();
  });
});

describe("10. סנכרון אחרי ניתוק", () => {
  async function setup() {
    const t = await dm(A, B);
    const m1 = msgOf(await send(A, t, "m1"));
    const m2 = msgOf(await send(A, t, "m2"));
    // B קורא ונשאר עם cursor
    const first = (await call(B, "GET", `/api/team/threads/${t}/messages`)).body as { cursor: number; messages: unknown[] };
    return { t, m1, m2, cursor: first.cursor };
  }
  const since = async (user: IdentifiedUser, t: number, c: number, extra = "") =>
    (await call(user, "GET", `/api/team/threads/${t}/messages?since=${c}${extra}`)).body as {
      messages: { id: number; body: string; deleted: boolean; rev: number; editedAt: string | null }[];
      hasMore: boolean;
      cursor: number;
    };

  it("עריכה ומחיקה של הודעה ישנה (לא בעמוד האחרון) בזמן ניתוק מגיעות ב-since", async () => {
    const { t, m1, m2, cursor } = await setup();
    for (let i = 0; i < 40; i++) await send(A, t, `מילוי ${i}`); // m1 נדחק מחוץ לעמוד האחרון (30)
    const afterFill = await since(B, t, cursor);
    const c2 = (await since(B, t, cursor, "&limit=100")).cursor;
    expect(afterFill.messages.length).toBeGreaterThan(0);

    await call(A, "PATCH", `/api/team/threads/${t}/messages/${m1.id}`, { body: "m1 ערוך" });
    await call(A, "DELETE", `/api/team/threads/${t}/messages/${m2.id}`);

    const sync = await since(B, t, c2);
    expect(sync.messages.map((x) => [x.id, x.body, x.deleted])).toEqual([
      [m1.id, "m1 ערוך", false],
      [m2.id, "הודעה נמחקה", true],
    ]);
    expect(sync.hasMore).toBe(false);
    // אחרי סנכרון: אין עוד שינויים
    expect((await since(B, t, sync.cursor)).messages).toEqual([]);
  });

  it("כמה שינויים רצופים באותה הודעה → פעם אחת, במצב העדכני; ללא כפילויות", async () => {
    const { t, m1, cursor } = await setup();
    for (const text of ["v1", "v2", "v3"]) await call(A, "PATCH", `/api/team/threads/${t}/messages/${m1.id}`, { body: text });
    const sync = await since(B, t, cursor);
    expect(sync.messages).toHaveLength(1);
    expect(sync.messages[0]).toMatchObject({ id: m1.id, body: "v3" });
    await call(A, "DELETE", `/api/team/threads/${t}/messages/${m1.id}`);
    const s2 = await since(B, t, sync.cursor);
    expect(s2.messages).toMatchObject([{ id: m1.id, deleted: true }]);
    expect(new Set([...sync.messages, ...s2.messages].map((x) => x.rev)).size).toBe(2);
  });

  it("הודעות חדשות יחד עם עריכות, בסדר rev חד-משמעי", async () => {
    const { t, m1, cursor } = await setup();
    const m3 = msgOf(await send(A, t, "m3"));
    await call(A, "PATCH", `/api/team/threads/${t}/messages/${m1.id}`, { body: "m1 ערוך" });
    const m4 = msgOf(await send(B, t, "m4"));
    const sync = await since(B, t, cursor);
    expect(sync.messages.map((x) => x.id)).toEqual([m3.id, m1.id, m4.id]);
    const revs = sync.messages.map((x) => x.rev);
    expect([...revs].sort((a, b) => a - b)).toEqual(revs);
    expect(new Set(revs).size).toBe(revs.length);
  });

  it("ניתוק ממושך: מעל limit → עמודים עם cursor, בלי פספוס ובלי כפילות", async () => {
    const { t, m1, cursor } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) ids.push(msgOf(await send(A, t, `n${i}`)).id);
    await call(A, "PATCH", `/api/team/threads/${t}/messages/${m1.id}`, { body: "ערוך אחרון" });

    const seen: number[] = [];
    let c = cursor;
    let pages = 0;
    for (;;) {
      const page = await since(B, t, c, "&limit=10");
      seen.push(...page.messages.map((x) => x.id));
      c = page.cursor;
      pages++;
      if (!page.hasMore) break;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([...ids, m1.id].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("הרשאות: סנכרון של משתמש זר → 404 זהה; cursor לא חושף כלום", async () => {
    const { t } = await setup();
    const foreign = await call(OWNER, "GET", `/api/team/threads/${t}/messages?since=0`);
    const missing = await call(OWNER, "GET", `/api/team/threads/999999/messages?since=0`);
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(missing);
  });

  it("פרמטרים לא תקינים → 400; since+before יחד → 400", async () => {
    const { t } = await setup();
    expect((await call(B, "GET", `/api/team/threads/${t}/messages?since=abc`)).status).toBe(400);
    expect((await call(B, "GET", `/api/team/threads/${t}/messages?since=-1`)).status).toBe(400);
    expect((await call(B, "GET", `/api/team/threads/${t}/messages?since=1&before=5`)).status).toBe(400);
  });

  it("rev ייחודי ועולה פר-שיחה ב-DB (טריגרים), גם בכתיבה גולמית", async () => {
    const t = await dm();
    db.prepare(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id) VALUES (?, 'dov', 'raw', 'r1')`).run(t);
    await send(A, t, "api");
    db.prepare(`UPDATE team_messages SET deleted_at = datetime('now') WHERE client_message_id = 'r1'`).run();
    const revs = (db.prepare(`SELECT rev FROM team_messages WHERE thread_id = ? ORDER BY id`).all(t) as { rev: number }[]).map((r) => r.rev);
    expect(revs).toEqual([3, 2]);
    // markRead לא מגדיל rev
    const before = (db.prepare(`SELECT MAX(rev) AS m FROM team_messages WHERE thread_id = ?`).get(t) as { m: number }).m;
    await call(B, "POST", `/api/team/threads/${t}/read`, { upTo: 99 });
    expect((db.prepare(`SELECT MAX(rev) AS m FROM team_messages WHERE thread_id = ?`).get(t) as { m: number }).m).toBe(before);
  });
});

describe("11-12. התראות קיימות ומונים לא מושפעים", () => {
  it("הודעות צוות לא יוצרות שורות notifications ולא משנות את מוני הפעמון", async () => {
    addNotification(B.key, "reminder", "קיימת", "fk-1");
    const rowsBefore = (db.prepare(`SELECT COUNT(*) AS c FROM notifications`).get() as { c: number }).c;
    const unseenBefore = listUnseenNotifications(B.key).length;
    const attendanceBefore = (db.prepare(`SELECT COUNT(*) AS c FROM attendance_events`).get() as { c: number }).c;
    const commitmentsBefore = (db.prepare(`SELECT COUNT(*) AS c FROM commitments`).get() as { c: number }).c;

    const t = await dm();
    const m = msgOf(await send(A, t, "x"));
    await call(A, "PATCH", `/api/team/threads/${t}/messages/${m.id}`, { body: "y" });
    await call(B, "POST", `/api/team/threads/${t}/read`, { upTo: m.id });
    await call(A, "DELETE", `/api/team/threads/${t}/messages/${m.id}`);

    expect((db.prepare(`SELECT COUNT(*) AS c FROM notifications`).get() as { c: number }).c).toBe(rowsBefore);
    expect(listUnseenNotifications(B.key).length).toBe(unseenBefore);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM attendance_events`).get() as { c: number }).c).toBe(attendanceBefore);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM commitments`).get() as { c: number }).c).toBe(commitmentsBefore);
  });

  it("סימון נקרא של הודעות צוות לא נוגע ב-seen_at של התראות, ולהפך", async () => {
    const id = addNotification(B.key, "reminder", "קיימת", "fk-2");
    const t = await dm();
    const m = msgOf(await send(A, t, "x"));
    await call(B, "POST", `/api/team/threads/${t}/read`, { upTo: m.id });
    expect(listUnseenNotifications(B.key).map((x) => x.id)).toContain(id);
    db.prepare(`UPDATE notifications SET seen_at = datetime('now') WHERE id = ?`).run(id);
    expect((await call(B, "GET", "/api/team/unread")).body).toEqual({ unread: 0 });
    const m2 = msgOf(await send(A, t, "עוד"));
    expect(m2.id).toBeGreaterThan(m.id);
    expect((await call(B, "GET", "/api/team/unread")).body).toEqual({ unread: 1 });
  });

  it("אירוע bus קיים (notification) ממשיך להגיע למנוי בדיוק כמו קודם", () => {
    const got: BusNotification[] = [];
    const un = subscribeNotifications((ev) => got.push(ev));
    publishNotificationLive({ userKey: B.key, id: 7, kind: "notification", body: "b", findingKey: null, itemId: null, itemSource: null, context: null, createdAt: "t" });
    un();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "notification", userKey: B.key, id: 7 });
  });
});
