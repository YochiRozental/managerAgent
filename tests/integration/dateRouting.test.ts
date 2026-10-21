/**
 * רגרסיה לבאג production (2026-10-21): בקשה ליום אחר מהיום קיבלה את סיכום *היום*.
 *   1. "הצג לי את כל המשימות שלי למחר"         → נכון (4 משימות)
 *   2. "תביא לי את כל מה שיש לי למחר"           → קיבל את סיכום היום  ✗
 *   3. "אני ביקשתי את מה שיש לי למחר!!!!!!!!"   → שוב סיכום היום       ✗
 * הסיבה: כלל prompt "'מה יש לי' → get_today_tasks" + finalizeText שמגיש את הסיכום מילה במילה, ואין
 * כלי ל"כל הסוגים". המודל המסוקרפט כאן *חוזר על הטעות* (קורא get_today_tasks) — הבדיקה מוכיחה שהקוד
 * מסרב בעצמו, בלי תלות בשיקול המודל. Monday/AI מדומים, DB זמני.
 */

import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

const { fetchUserOpsTasksMock, fetchLeadsMock, fetchDealsMock, getEmployeeFeedMock } = vi.hoisted(() => ({
  fetchUserOpsTasksMock: vi.fn(),
  fetchLeadsMock: vi.fn(),
  fetchDealsMock: vi.fn(),
  getEmployeeFeedMock: vi.fn(),
}));

vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUserOpsTasks: fetchUserOpsTasksMock, getProjectNextAction: async () => null };
});
vi.mock(import("../../src/integrations/monday/bulkRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchLeadsForBulk: fetchLeadsMock, fetchDealsForBulk: fetchDealsMock };
});
vi.mock(import("../../src/ops/employeeFeed.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getEmployeeFeed: getEmployeeFeedMock,
    formatEmployeeFeedBriefing: () => "BRIEFING-TODAY: סדר העבודה שלך להיום",
    employeeFeedCounts: () => ({}),
  };
});

import { env } from "../../src/config/env.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import { resolveDateExpr, resolveSingleDay } from "../../src/ops/relativeDates.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { RunModelParams, RunModelResult } from "../../src/ai/providers/types.js";
import type { OpsTask } from "../../src/integrations/monday/opsRead.js";
import type { BulkLead } from "../../src/integrations/monday/bulkRead.js";

const moti = resolveUserByKey("moti")!;
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };
const ALL = ["tasks", "leads", "deals", "commitments"];

const now = () => DateTime.now().setZone(env.TIMEZONE);
const TOMORROW = resolveDateExpr("מחר", now())!.from;
const SUNDAY = resolveSingleDay("יום ראשון", now())!;
const PAST = now().minus({ days: 5 }).toFormat("yyyy-MM-dd");

const task = (itemId: string, dueDate: string): OpsTask => ({
  source: "general", itemId, name: `משימה ${itemId}`, url: "", context: "משימת משרד", status: "לביצוע", dueDate, assignees: moti.name,
});
const TASKS = [task("1", TOMORROW), task("2", TOMORROW), task("3", TOMORROW), task("4", TOMORROW), task("9", PAST), task("7", SUNDAY)];
const lead = (itemId: string, reminderDate: string): BulkLead => ({
  itemId, name: `ליד ${itemId}`, status: "ליד חדש", reminderDate, owner: moti.name, ownerIds: [moti.mondayUserId!], source: "", product: "", url: "",
});

function call(name: string, input: Record<string, unknown> = {}): RunModelResult {
  const id = `tc-${name}-${Math.random().toString(36).slice(2, 7)}`;
  return { text: "", toolCalls: [{ id, name, input }], assistantContent: [{ type: "tool_use", id, name, input }], usage: USAGE };
}
const text = (t: string): RunModelResult => ({ text: t, toolCalls: [], assistantContent: [{ type: "text", text: t }], usage: USAGE });
function scripted(steps: RunModelResult[], seen: RunModelParams[]): RunModelFn {
  let i = 0;
  return (async (p: RunModelParams) => {
    seen.push(p);
    return steps[Math.min(i++, steps.length - 1)]!;
  }) as unknown as RunModelFn;
}
function conversation(session = `dr-${Math.random().toString(36).slice(2, 8)}`) {
  const history: ChatMessage[] = [];
  let n = 0;
  return async (userText: string, steps: RunModelResult[], seen: RunModelParams[] = []) => {
    history.push({ role: "user", content: userText });
    const r = await runOpsChat(moti, [...history], { session, clientMessageId: `${session}-${++n}`, _runModel: scripted(steps, seen), _config: TEST_CONFIG });
    history.push({ role: "assistant", content: r.reply });
    return r;
  };
}



beforeEach(() => {
  fetchUserOpsTasksMock.mockReset().mockResolvedValue(TASKS);
  fetchLeadsMock.mockReset().mockResolvedValue([lead("L1", TOMORROW), lead("L2", PAST)]);
  fetchDealsMock.mockReset().mockResolvedValue([]);
  getEmployeeFeedMock.mockReset().mockResolvedValue({});
});

describe("רצף השיחה המדויק מה-production", () => {
  it("1→2→3: 'למחר' לעולם לא מקבל את סיכום היום, גם כשהמודל מנסה", async () => {
    const say = conversation();

    const r1 = await say("הצג לי את כל המשימות שלי למחר", [call("query_records", { recordType: "tasks", date: "מחר" }), text("x")]);
    expect(r1.reply).toMatch(/^נמצאו 4 משימות/);

    // 2 — המודל חוזר על טעות ה-production: get_today_tasks. הקוד מסרב ומפנה; המודל ממשיך ל-query_records
    const seen2: RunModelParams[] = [];
    const r2 = await say(
      "תביא לי את כל מה שיש לי למחר",
      [call("get_today_tasks"), call("query_records", { recordTypes: ALL, date: "מחר" }), text("x")],
      seen2,
    );
    expect(JSON.stringify(seen2.at(-1)!.messages)).toContain("סיכום היום אינו התשובה");
    expect(r2.reply).not.toContain("BRIEFING-TODAY");
    expect(r2.reply).toMatch(/^נמצאו 5 רשומות/);
    expect(r2.reply).toMatch(/משימות \(4\)[\s\S]*לידים \(1\)[\s\S]*עסקאות \(0\)[\s\S]*התחייבויות \(0\)/);
    expect(r2.reply).not.toContain("משימה 9"); // באיחור — לא חלק מ"מחר"
    expect(r2.reply).not.toContain("ליד L2");

    // 3 — תיקון בצעקה; המודל *שוב* קורא get_today_tasks ואז עונה בטקסט — הסיכום לא מוגש בשום מקרה
    const seen3: RunModelParams[] = [];
    const r3 = await say("אני ביקשתי את מה שיש לי למחר!!!!!!!!", [call("get_today_tasks"), text("סליחה — הנה מה שיש לך מחר")], seen3);
    expect(JSON.stringify(seen3.at(-1)!.messages)).toContain("סיכום היום אינו התשובה");
    expect(r3.reply).not.toContain("BRIEFING-TODAY");
    expect(getEmployeeFeedMock).not.toHaveBeenCalled(); // הסיכום לא נבנה אפילו פעם אחת
  });

  it("'מה יש לי היום' — סיכום היום נשאר בדיוק כמו קודם", async () => {
    const say = conversation();
    const r = await say("מה יש לי היום", [call("get_today_tasks"), text("x")]);
    expect(r.reply).toContain("BRIEFING-TODAY");
    expect(getEmployeeFeedMock).toHaveBeenCalledTimes(1);
  });

  it("'בוקר טוב' (בלי תאריך) — סיכום היום, ללא שינוי", async () => {
    const r = await conversation()("בוקר טוב", [call("get_today_tasks"), text("x")]);
    expect(r.reply).toContain("BRIEFING-TODAY");
  });

  it("'מה יש לי ביום ראשון' — הפעילויות של אותו יום בלבד", async () => {
    const r = await conversation()("מה יש לי ביום ראשון", [call("get_today_tasks"), call("query_records", { recordTypes: ALL, date: "יום ראשון" }), text("x")]);
    expect(r.reply).not.toContain("BRIEFING-TODAY");
    expect(r.reply).toContain("משימה 7");
    expect(r.reply).not.toContain("משימה 1 ");
    expect(r.reply).not.toContain("משימה 9");
  });

  it("'תביא גם את הלידים' — מרחיב את התוצאה הקודמת, שומר תאריך ומשתמש", async () => {
    const say = conversation();
    await say("הצג לי את כל המשימות שלי למחר", [call("query_records", { recordType: "tasks", date: "מחר" }), text("x")]);
    const r = await say("תביא גם את הלידים", [call("query_records", { base: "last", recordTypes: ["tasks", "leads"] }), text("x")]);
    expect(fetchLeadsMock).toHaveBeenLastCalledWith(moti.mondayUserId);
    expect(r.reply).toMatch(/^נמצאו 5 רשומות/);
    expect(r.reply).toMatch(/משימות \(4\)[\s\S]*לידים \(1\)/);
    expect(r.reply).not.toContain("ליד L2");
  });

  it("'לא, ביקשתי למחר' — תיקון התאריך של הבקשה הקודמת, לא חזרה על אותה תשובה", async () => {
    const say = conversation();
    const r1 = await say("מה יש לי ביום ראשון", [call("query_records", { recordTypes: ALL, date: "יום ראשון" }), text("x")]);
    const r2 = await say("לא, ביקשתי למחר", [call("get_my_pipeline"), call("query_records", { base: "last", date: "מחר" }), text("x")]);
    expect(r2.reply).not.toBe(r1.reply);
    expect(r2.reply).toMatch(/משימות \(4\)/);
    expect(r2.reply).not.toContain("משימה 7");
  });

  it("בקשה עם תאריך אחר עוברת את כלי הסיכום *בלי* לשנות את רשימת הכלים (מטמון ה-prompt)", async () => {
    const seenA: RunModelParams[] = [];
    const seenB: RunModelParams[] = [];
    await conversation()("מה יש לי היום", [text("x")], seenA);
    await conversation()("מה יש לי מחר", [text("x")], seenB);
    expect(seenB[0]!.tools.map((t) => t.name)).toEqual(seenA[0]!.tools.map((t) => t.name));
  });
});
