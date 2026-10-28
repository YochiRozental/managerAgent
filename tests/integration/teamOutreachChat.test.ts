/**
 * פנייה לעובד דרך הסוכן (שלב 3) — prepare/confirm/cancel. המודל מסוקרפט (_runModel) — אפס קריאת AI; Monday
 * מדומה; DB זמני מבודד. חלק מהבדיקות עוברות דרך runOpsChat (חיווט, אישור בהודעה נפרדת, ניתוב), וחלק ישירות על
 * ops/teamOutreach.ts עם הזרקת כשלים (שליחה / השלמת רישום).
 */

import "dotenv/config";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

const { fetchUserOpsTasksMock } = vi.hoisted(() => ({ fetchUserOpsTasksMock: vi.fn() }));
vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUserOpsTasks: fetchUserOpsTasksMock, getProjectNextAction: async () => null };
});

import { db } from "../../src/db/db.js";
import { env } from "../../src/config/env.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import {
  buildOutreachContextLines,
  cancelTeamOutreach,
  confirmTeamOutreach,
  looksLikeOutreachRequest,
  prepareTeamOutreach,
  resolveOutreachRecipient,
} from "../../src/ops/teamOutreach.js";
import { getOutreach, getPendingDraft, listOutreach, listSending } from "../../src/db/repositories/agentOutreach.js";
import { listMessages, openDm, unreadTotal } from "../../src/db/repositories/teamMessages.js";
import { subscribeNotifications, type BusNotification } from "../../src/ops/notificationBus.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { RunModelParams, RunModelResult } from "../../src/ai/providers/types.js";

const dov = resolveUserByKey("dov")!;
const eitan = resolveUserByKey("eitan")!;
const moti = resolveUserByKey("moti")!;
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };
const TEXT = "היי איתן, אפשר עדכון על התכניות של רמות עד סוף היום?";

function call(name: string, input: Record<string, unknown> = {}): RunModelResult {
  const id = `tc-${name}-${Math.random().toString(36).slice(2, 7)}`;
  return { text: "", toolCalls: [{ id, name, input }], assistantContent: [{ type: "tool_use", id, name, input }], usage: USAGE };
}
const text = (t: string): RunModelResult => ({ text: t, toolCalls: [], assistantContent: [{ type: "text", text: t }], usage: USAGE });
function scripted(steps: RunModelResult[], seen: RunModelParams[] = []): RunModelFn {
  let i = 0;
  return (async (params: RunModelParams) => {
    seen.push(params);
    return steps[Math.min(i++, steps.length - 1)]!;
  }) as unknown as RunModelFn;
}
function conversation(user = dov, session = `outreach-${Math.random().toString(36).slice(2, 8)}`) {
  const history: ChatMessage[] = [];
  let n = 0;
  const say = async (userText: string, steps: RunModelResult[], seen?: RunModelParams[]) => {
    history.push({ role: "user", content: userText });
    const r = await runOpsChat(user, [...history], { session, clientMessageId: `${session}-m${++n}`, _runModel: scripted(steps, seen), _config: TEST_CONFIG });
    history.push({ role: "assistant", content: r.reply });
    return r;
  };
  return Object.assign(say, { session });
}

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const teamBodies = () => (db.prepare(`SELECT sender_key, body FROM team_messages ORDER BY id`).all() as { sender_key: string; body: string }[]);
const nowDt = () => DateTime.now().setZone(env.TIMEZONE);
const ctxFor = (session: string, turnId: string, now = nowDt()) => ({ sessionId: session, turnId, now });

beforeEach(() => {
  fetchUserOpsTasksMock.mockReset().mockResolvedValue([]);
  db.exec(`DELETE FROM agent_outreach`);
  db.exec(`DELETE FROM team_messages`);
  db.exec(`DELETE FROM team_thread_members`);
  db.exec(`DELETE FROM team_threads`);
});

describe("זרימה דרך הצ'אט", () => {
  it("1-3: הכנה לא שולחת, מציגה נמען ונוסח מדויקים; אישור בהודעה נפרדת שולח בשם המשתמש", async () => {
    const say = conversation();
    const notifBefore = count("notifications");

    const r1 = await say("תשאל את איתן איפה התכניות של רמות", [call("prepare_team_outreach", { recipient: "איתן", text: TEXT }), text("הכנתי")]);
    expect(r1.reply).toContain("אשלח לאיתן ברמן");
    expect(r1.reply).toContain(`«${TEXT}»`);
    expect(r1.reply).toContain("לשלוח?");
    expect(r1.reply).not.toBe("הכנתי"); // התצוגה מוגשת מילה במילה
    expect(teamBodies()).toEqual([]);
    expect(count("team_messages")).toBe(0);
    expect(getPendingDraft(dov.key, say.session)?.body).toBe(TEXT);

    const seen2: RunModelParams[] = [];
    const r2 = await say("כן", [call("confirm_team_outreach", {}), text("נשלח!")], seen2);
    expect(seen2[0]!.system).toMatch(/פנייה לאיתן ברמן ממתינה לאישור/);
    expect(r2.reply).toBe(`✓ נשלחה לאיתן ברמן, בשמך: «${TEXT}»`);
    expect(r2.actions).toEqual(["💬 נשלחה הודעה לאיתן ברמן"]);
    expect(teamBodies()).toEqual([{ sender_key: "dov", body: TEXT }]);
    expect(count("notifications")).toBe(notifBefore);
    expect(unreadTotal(eitan.key)).toBe(1);
    expect(unreadTotal(dov.key)).toBe(0);
  });

  it("4: הכנה ואישור באותה הודעה — נחסם; לא נשלח כלום", async () => {
    const say = conversation();
    const r = await say("תשלח לאיתן הודעה", [
      call("prepare_team_outreach", { recipient: "איתן", text: TEXT }),
      call("confirm_team_outreach", {}),
      text("נשלח!"),
    ]);
    expect(r.reply).toContain("אשלח לאיתן ברמן");
    expect(r.reply).not.toContain("נשלח!");
    expect(count("team_messages")).toBe(0);
    expect(listOutreach(dov.key, say.session)[0]!.status).toBe("draft");
  });

  it("4b: המודל מנסה confirm כשההודעה האחרונה אינה אישור — לא נשלח", async () => {
    const say = conversation();
    await say("תשאל את איתן", [call("prepare_team_outreach", { recipient: "איתן", text: TEXT }), text("x")]);
    const r = await say("רגע, מה כתבת שם בדיוק?", [call("confirm_team_outreach", {}), text("שלחתי")]);
    expect(count("team_messages")).toBe(0);
    expect(r.reply).toMatch(/לא אישור חד-משמעי/);
    expect(getPendingDraft(dov.key, say.session)).not.toBeNull();
  });

  it("5: 'כן, אבל...' ואישור עמום — לא נשלח; הטיוטה נשארת ממתינה", async () => {
    const say = conversation();
    await say("תשאל את איתן", [call("prepare_team_outreach", { recipient: "איתן", text: TEXT }), text("x")]);
    for (const vague of ["כן, אבל תוסיף שזה דחוף", "אולי", "נראה לי בסדר?", "כן כן, רק בלי הסוף"]) {
      const r = await say(vague, [call("confirm_team_outreach", {}), text("שלחתי")]);
      expect(r.reply, vague).toMatch(/לא אישור חד-משמעי/);
    }
    expect(count("team_messages")).toBe(0);
    expect(getPendingDraft(dov.key, say.session)).not.toBeNull();
  });

  it("6: שינוי נוסח = טיוטה חדשה; הקודמת מבוטלת ורק החדשה נשלחת אחרי אישור חדש", async () => {
    const say = conversation();
    await say("תשאל את איתן", [call("prepare_team_outreach", { recipient: "איתן", text: TEXT }), text("x")]);
    const first = listOutreach(dov.key, say.session)[0]!;
    const r2 = await say("תוסיף שזה דחוף", [call("prepare_team_outreach", { recipient: "איתן", text: `${TEXT} זה דחוף.` }), text("x")]);
    expect(r2.reply).toContain("זה דחוף.");
    expect(getOutreach(first.id, dov.key)!.status).toBe("cancelled");
    expect(count("team_messages")).toBe(0);
    await say("כן", [call("confirm_team_outreach", {}), text("x")]);
    expect(teamBodies()).toEqual([{ sender_key: "dov", body: `${TEXT} זה דחוף.` }]);
    // ניסיון לאשר את הישנה בפירוש — נדחה
    const r4 = await say("כן", [call("confirm_team_outreach", { outreachId: first.id }), text("x")]);
    expect(r4.reply).toMatch(/בוטלה|הוחלפה/);
    expect(count("team_messages")).toBe(1);
  });

  it("7: ביטול — לא נשלח, ו'כן' אחריו לא שולח", async () => {
    const say = conversation();
    await say("תשאל את איתן", [call("prepare_team_outreach", { recipient: "איתן", text: TEXT }), text("x")]);
    const r = await say("לא, עזוב", [call("cancel_team_outreach", {}), text("x")]);
    expect(r.reply).toBe("בוטל — לא שלחתי הודעה לאיתן ברמן.");
    const r2 = await say("כן", [call("confirm_team_outreach", {}), text("x")]);
    expect(r2.reply).toMatch(/אין פנייה לעובד שממתינה/);
    expect(count("team_messages")).toBe(0);
  });

  it("10: אישור כפול (שתי הודעות 'כן') — הודעה אחת בלבד", async () => {
    const say = conversation();
    await say("תשאל את איתן", [call("prepare_team_outreach", { recipient: "איתן", text: TEXT }), text("x")]);
    await say("כן", [call("confirm_team_outreach", {}), text("x")]);
    const r2 = await say("כן", [call("confirm_team_outreach", {}), text("x")]);
    expect(r2.reply).toMatch(/אין פנייה לעובד שממתינה/);
    expect(count("team_messages")).toBe(1);
  });

  it("נמען עמום / לא קיים / עצמי דרך הצ'אט — מוצג בשגיאה ולא נוצרת טיוטה", async () => {
    const say = conversation();
    for (const recipient of ["נועה", "דוב ואיתן", "דוב"]) {
      const r = await say(`תשאל את ${recipient}`, [call("prepare_team_outreach", { recipient, text: TEXT }), text("הכנתי")]);
      expect(r.reply, recipient).not.toBe("הכנתי");
    }
    expect(listOutreach(dov.key, say.session)).toEqual([]);
  });

  it("14: חשיפה ב-Web בלבד, ניתוב SMART רק בפנייה, ושאר הכלים לא השתנו", async () => {
    const seenA: RunModelParams[] = [];
    const seenB: RunModelParams[] = [];
    const seenC: RunModelParams[] = [];
    await conversation()("בוקר טוב", [text("x")], seenA);
    await conversation()("תשלח לאיתן הודעה שאני מאחר", [text("x")], seenB);
    await conversation(moti)("מה יש לי היום?", [text("x")], seenC);
    const names = seenA[0]!.tools.map((t) => t.name);
    for (const t of ["prepare_team_outreach", "confirm_team_outreach", "cancel_team_outreach"]) expect(names).toContain(t);
    for (const t of ["get_today_tasks", "find_task", "query_records", "prepare_bulk_update", "confirm_bulk_update", "record_commitment"]) expect(names).toContain(t);
    expect(seenA[0]!.model).toBe("test-fast");
    expect(seenB[0]!.model).toBe("test-smart");
    expect(seenC[0]!.model).toBe("test-fast");
    expect(seenA[0]!.system).not.toMatch(/פניות לעובדים/); // בלי מצב פעיל ה-prompt לא משתנה

    const wa = fs.readFileSync(new URL("../../src/integrations/claude/tools.ts", import.meta.url), "utf-8");
    expect(wa).not.toMatch(/team_outreach/);
  });

  it("13ב: שיחה עם טיוטה ממתינה מנותבת ל-SMART וה-prompt מציין אותה", async () => {
    const say = conversation();
    await say("תשאל את איתן", [call("prepare_team_outreach", { recipient: "איתן", text: TEXT }), text("x")]);
    const seen: RunModelParams[] = [];
    await say("כן", [text("x")], seen);
    expect(seen[0]!.model).toBe("test-smart");
    expect(seen[0]!.system).toContain("ao_");
  });
});

describe("זיהוי נמען וניתוב (טהור)", () => {
  it("8: לא קיים / עמום / ריק", () => {
    expect(resolveOutreachRecipient("נועה")).toMatchObject({ ok: false });
    expect(resolveOutreachRecipient("")).toMatchObject({ ok: false });
    expect(resolveOutreachRecipient(undefined)).toMatchObject({ ok: false });
    const amb = resolveOutreachRecipient("ch");
    expect(amb.ok).toBe(false);
    expect((amb as { error: string }).error).toMatch(/יותר מעובד אחד/);
    expect(resolveOutreachRecipient("דוב ואיתן")).toMatchObject({ ok: false });
  });

  it("זיהוי חד-משמעי: שם, שם חלקי, 'לדוב', כינוי, מפתח", () => {
    for (const [q, key] of [["איתן ברמן", "eitan"], ["רוחמה", "ruchama"], ["לדוב", "dov"], ["Yochi", "yochi"], ["goldi", "goldi"]] as const) {
      const r = resolveOutreachRecipient(q);
      expect(r.ok && r.member.key, q).toBe(key);
    }
  });

  it("9: פנייה לעצמך נדחית", () => {
    const r = prepareTeamOutreach(dov, ctxFor("s", "t1"), { recipient: "דוב", text: "x" });
    expect(r).toEqual({ ok: false, error: "אי אפשר לשלוח הודעה לעצמך." });
    expect(prepareTeamOutreach(moti, ctxFor("s", "t1"), { recipient: "מוטי", text: "x" }).ok).toBe(false);
    expect(prepareTeamOutreach(dov, ctxFor("s", "t1"), { recipient: "איתן", text: "  " }).ok).toBe(false);
    expect(prepareTeamOutreach(dov, ctxFor("s", "t1"), { recipient: "איתן", text: "א".repeat(4001) }).ok).toBe(false);
    expect(count("agent_outreach")).toBe(0);
  });

  it("looksLikeOutreachRequest", () => {
    for (const t of ["תשאל את דוב איפה התכניות", "תשלח לאיתן הודעה", "תבקש מרוחמה עדכון", "תפנה לגולדי בעניין החשבונית"]) expect(looksLikeOutreachRequest(t), t).toBe(true);
    for (const t of ["בוקר טוב", "מה יש לי היום?", "סיימתי את התכניות", "מה קורה עם הפרויקט של דוב?"]) expect(looksLikeOutreachRequest(t), t).toBe(false);
  });
});

describe("כשלים והתאוששות", () => {
  function prepared(session = "s-rec") {
    const p = prepareTeamOutreach(dov, ctxFor(session, "t-prep"), { recipient: "איתן", text: TEXT });
    expect(p.ok).toBe(true);
    return (p as { outreachId: string }).outreachId;
  }

  it("11א: ההודעה נשלחה אך completeSend נכשל — לא כפילות; אישור חוזר משלים את אותה הודעה", async () => {
    const id = prepared();
    const r1 = await confirmTeamOutreach(dov, { ...ctxFor("s-rec", "t-c1"), latestUserMessage: "כן" }, {}, {
      complete: () => {
        throw new Error("disk");
      },
    });
    expect(r1.ok).toBe(true);
    expect((r1 as { text: string }).text).toContain("נשלחה לאיתן ברמן");
    expect((r1 as { text: string }).text).toContain("הרישום הפנימי");
    expect(getOutreach(id, dov.key)!.status).toBe("sending");
    expect(count("team_messages")).toBe(1);
    const firstMsg = teamBodies();

    const notices: BusNotification[] = [];
    const unsub = subscribeNotifications((n) => notices.push(n));
    const stuckContext = buildOutreachContextLines(dov.key, "s-rec", nowDt());
    expect(stuckContext.join("\n")).toMatch(/נתקעה באמצע שליחה/);

    // בלי אישור מפורש — לא משלימים
    const bad = await confirmTeamOutreach(dov, { ...ctxFor("s-rec", "t-c2"), latestUserMessage: "מה?" }, {});
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/נתקעה באמצע שליחה/);

    const r2 = await confirmTeamOutreach(dov, { ...ctxFor("s-rec", "t-c3"), latestUserMessage: "כן" }, {});
    unsub();
    expect(r2.ok).toBe(true);
    expect((r2 as { text: string }).text).toBe("ההודעה לאיתן ברמן כבר נשלחה קודם — לא שלחתי שוב.");
    expect((r2 as { executed: boolean }).executed).toBe(false);
    expect(notices).toEqual([]); // אין אירוע מטעה
    expect(teamBodies()).toEqual(firstMsg);
    expect(count("team_messages")).toBe(1);
    expect(getOutreach(id, dov.key)).toMatchObject({ status: "sent" });
    expect(getOutreach(id, dov.key)!.teamMessageId).not.toBeNull();
    expect(listSending(dov.key)).toEqual([]);
  });

  it("11ב: השליחה עצמה נכשלה — לא מדווחים 'נשלח', נשאר sending, וניסיון חוזר שולח פעם אחת", async () => {
    const id = prepared();
    const r1 = await confirmTeamOutreach(dov, { ...ctxFor("s-rec", "t-c1"), latestUserMessage: "כן" }, {}, {
      sendDirect: () => {
        throw new Error("boom");
      },
    });
    expect(r1.ok).toBe(false);
    expect((r1 as { error: string }).error).toMatch(/לא ידוע אם הגיעה/);
    expect((r1 as { error: string }).error).not.toMatch(/^✓/);
    expect(getOutreach(id, dov.key)!.status).toBe("sending"); // אין איפוס אוטומטי ל-draft
    expect(count("team_messages")).toBe(0);

    const r2 = await confirmTeamOutreach(dov, { ...ctxFor("s-rec", "t-c2"), latestUserMessage: "כן" }, { outreachId: id });
    expect(r2.ok).toBe(true);
    expect((r2 as { text: string }).text).toContain("✓ נשלחה לאיתן ברמן");
    expect(count("team_messages")).toBe(1);
    const r3 = await confirmTeamOutreach(dov, { ...ctxFor("s-rec", "t-c3"), latestUserMessage: "כן" }, { outreachId: id });
    expect((r3 as { text: string }).text).toMatch(/כבר נשלחה/);
    expect(count("team_messages")).toBe(1);
  });

  it("ביטול לא מאפשר לבטל פנייה תקועה", async () => {
    prepared();
    await confirmTeamOutreach(dov, { ...ctxFor("s-rec", "t-c1"), latestUserMessage: "כן" }, {}, { sendDirect: () => { throw new Error("x"); } });
    const r = cancelTeamOutreach(dov, { sessionId: "s-rec", now: nowDt() });
    expect(r.ok).toBe(false);
    expect(listSending(dov.key)).toHaveLength(1);
  });

  it("10ב: שני אישורים מקבילים — הודעה אחת", async () => {
    prepared();
    const ctx = { ...ctxFor("s-rec", "t-par"), latestUserMessage: "כן" };
    const results = await Promise.all([confirmTeamOutreach(dov, ctx, {}), confirmTeamOutreach(dov, ctx, {})]);
    expect(count("team_messages")).toBe(1);
    expect(results.filter((r) => r.ok && r.executed).length).toBe(1);
  });
});

describe("בידוד ופקיעה", () => {
  it("12: משתמש אחר / שיחת סוכן אחרת לא מאשרים ולא רואים את הפנייה", async () => {
    const p = prepareTeamOutreach(dov, ctxFor("s-a", "t1"), { recipient: "איתן", text: TEXT });
    const id = (p as { outreachId: string }).outreachId;

    const other = await confirmTeamOutreach(moti, { ...ctxFor("s-a", "t2"), latestUserMessage: "כן" }, { outreachId: id });
    const otherSess = await confirmTeamOutreach(dov, { ...ctxFor("s-b", "t2"), latestUserMessage: "כן" }, { outreachId: id });
    const otherSessNoId = await confirmTeamOutreach(dov, { ...ctxFor("s-b", "t2"), latestUserMessage: "כן" }, {});
    for (const r of [other, otherSess, otherSessNoId]) expect(r.ok).toBe(false);
    expect(count("team_messages")).toBe(0);
    expect(getOutreach(id, dov.key)!.status).toBe("draft");
    expect(buildOutreachContextLines(moti.key, "s-a", nowDt())).toEqual([]);
    expect(buildOutreachContextLines(dov.key, "s-b", nowDt())).toEqual([]);
    expect(cancelTeamOutreach(moti, { sessionId: "s-a", now: nowDt() }).ok).toBe(false);
    expect(getPendingDraft(dov.key, "s-a")).not.toBeNull();
  });

  it("13: טיוטה שפג תוקפה לא נשלחת", async () => {
    const p = prepareTeamOutreach(dov, ctxFor("s-x", "t1"), { recipient: "איתן", text: TEXT });
    const id = (p as { outreachId: string }).outreachId;
    const later = nowDt().plus({ minutes: 31 });
    const r = await confirmTeamOutreach(dov, { ...ctxFor("s-x", "t2", later), latestUserMessage: "כן" }, {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/פגה/);
    expect(count("team_messages")).toBe(0);
    const byId = await confirmTeamOutreach(dov, { ...ctxFor("s-x", "t3", later), latestUserMessage: "כן" }, { outreachId: id });
    expect(byId.ok).toBe(false);
    expect(count("team_messages")).toBe(0);
    expect(buildOutreachContextLines(dov.key, "s-x", later)).toEqual([]);
  });

  it("15: עצם האישור לא יוצר התראות ולא משנה unread של השולח; הנמען מקבל unread רגיל של הודעת צוות", async () => {
    const { threadId } = openDm(dov.key, eitan.key);
    prepareTeamOutreach(dov, ctxFor("s-n", "t1"), { recipient: "איתן", text: TEXT });
    const before = { notif: count("notifications"), dov: unreadTotal(dov.key) };
    const r = await confirmTeamOutreach(dov, { ...ctxFor("s-n", "t2"), latestUserMessage: "כן" }, {});
    expect(r.ok).toBe(true);
    expect(count("notifications")).toBe(before.notif);
    expect(unreadTotal(dov.key)).toBe(before.dov);
    expect(unreadTotal(eitan.key)).toBe(1);
    expect(listMessages(dov.key, threadId).messages).toHaveLength(1);
  });
});
