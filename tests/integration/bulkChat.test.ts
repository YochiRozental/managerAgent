/**
 * סינון + עדכון קבוצתי מקצה לקצה דרך runOpsChat — שיחת המשך אמיתית על פני כמה הודעות:
 *   "הצג את המשימות של איתן למחר" → "חוץ מפרויקט רמות" → "תעביר את כולן ליום ראשון" → "כן" → "כן" (שוב).
 *
 * המודל מסוקרפט (_runModel) — אפס קריאת AI. Monday מדומה: fetchUserOpsTasks / readItemsForVerification /
 * setItemColumnValues מוחלפים ב-vi.mock. DB זמני מבודד. אף כתיבה אמיתית.
 */

import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

const { fetchUserOpsTasksMock, readItemsMock, setValuesMock } = vi.hoisted(() => ({
  fetchUserOpsTasksMock: vi.fn(),
  readItemsMock: vi.fn(),
  setValuesMock: vi.fn(),
}));

vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUserOpsTasks: fetchUserOpsTasksMock, getProjectNextAction: async () => null };
});
vi.mock(import("../../src/integrations/monday/bulkRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readItemsForVerification: readItemsMock };
});
vi.mock(import("../../src/integrations/monday/itemWrite.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, setItemColumnValues: setValuesMock };
});

import { env } from "../../src/config/env.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import { resolveDateExpr, resolveSingleDay } from "../../src/ops/relativeDates.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { RunModelParams, RunModelResult } from "../../src/ai/providers/types.js";
import type { OpsTask } from "../../src/integrations/monday/opsRead.js";
import type { ItemSnapshot } from "../../src/integrations/monday/bulkRead.js";

const moti = resolveUserByKey("moti")!;
const eitan = resolveUserByKey("eitan")!;
const ruchama = resolveUserByKey("ruchama")!;
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };

// runOpsChat מחשב "עכשיו" בעצמו — הנתונים נבנים יחסית לאותו "עכשיו"
const now = () => DateTime.now().setZone(env.TIMEZONE);
const TOMORROW = resolveDateExpr("מחר", now())!.from;
const SUNDAY = resolveSingleDay("יום ראשון", now())!;

function task(itemId: string, project: string): OpsTask {
  return {
    source: "project_stage",
    itemId,
    name: `משימה ${itemId}`,
    url: "https://x.test",
    context: project,
    projectId: `P-${project}`,
    stageName: "שלב 1",
    status: "לביצוע",
    dueDate: TOMORROW,
    assignees: eitan.name,
  };
}
const TASKS = [task("101", "בית כנסת רמות"), task("102", "מעון גבעת שאול"), task("103", "וילה הרצליה")];
const snapOf = (t: OpsTask): ItemSnapshot => ({
  itemId: t.itemId,
  kind: "project_stage",
  boardId: "1550734556",
  name: t.name,
  status: t.status,
  date: t.dueDate,
  assigneeIds: [eitan.mondayUserId!],
  projectId: t.projectId,
});

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

/** שיחה מתמשכת: כל turn מוסיף הודעת משתמש + תשובה להיסטוריה, באותו session. */
function conversation(user = moti, session = `bulk-chat-${Math.random().toString(36).slice(2, 8)}`) {
  const history: ChatMessage[] = [];
  let n = 0;
  return async (userText: string, steps: RunModelResult[], seen?: RunModelParams[]) => {
    history.push({ role: "user", content: userText });
    const r = await runOpsChat(user, [...history], {
      session,
      clientMessageId: `${session}-m${++n}`,
      _runModel: scripted(steps, seen),
      _config: TEST_CONFIG,
    });
    history.push({ role: "assistant", content: r.reply });
    return r;
  };
}

beforeEach(() => {
  fetchUserOpsTasksMock.mockReset().mockResolvedValue(TASKS);
  readItemsMock.mockReset().mockImplementation(async (ids: string[]) => new Map(TASKS.filter((t) => ids.includes(t.itemId)).map((t) => [t.itemId, snapOf(t)])));
  setValuesMock.mockReset().mockResolvedValue(undefined);
});

describe("שיחת המשך: הצגה → צמצום → עדכון → אישור", () => {
  it("כל השלבים, עם הגנות האישור והכפילות", async () => {
    const say = conversation();

    // 1. הצגה מסוננת — הרשימה מוגשת מילה במילה (לא "סיכום" של המודל)
    const r1 = await say("הצג את המשימות של איתן למחר", [
      call("query_records", { recordType: "tasks", assignees: ["איתן"], date: "מחר" }),
      text("יש לאיתן כמה משימות"),
    ]);
    expect(fetchUserOpsTasksMock).toHaveBeenCalledWith(eitan.mondayUserId);
    expect(r1.reply).toMatch(/^נמצאו 3 משימות/);
    expect(r1.reply).toContain("משימה 101 — בית כנסת רמות");

    // 2. "חוץ מ..." — base='last': הסינון הקודם (איתן+מחר) נשמר, רק ההחרגה נוספת
    const seen2: RunModelParams[] = [];
    const r2 = await say(
      "חוץ מהמשימות של פרויקט רמות",
      [call("query_records", { base: "last", excludeProjects: ["רמות"] }), text("x")],
      seen2,
    );
    expect(seen2[0]!.system).toMatch(/קבוצת התוצאות האחרונה בשיחה: 3 משימות/);
    expect(fetchUserOpsTasksMock).toHaveBeenLastCalledWith(eitan.mondayUserId);
    expect(r2.reply).toMatch(/^נמצאו 2 משימות \(.*של: איתן ברמן.*חוץ מפרויקט: רמות/);
    expect(r2.reply).not.toContain("משימה 101");

    // 3. "תעביר את כולן" — תצוגה מקדימה; המודל "מתפרע" ומנסה לאשר באותו סבב → נחסם בקוד
    const r3 = await say("תעביר את כולן ליום ראשון", [
      call("prepare_bulk_update", { dueDate: "יום ראשון" }),
      call("confirm_bulk_update", {}),
      text("בוצע!"),
    ]);
    expect(r3.reply).toMatch(/תצוגה מקדימה — עדכון קבוצתי \(עדיין לא בוצע שום שינוי\)/);
    expect(r3.reply).toMatch(/יעודכנו 2 משימות/);
    expect(r3.reply).not.toContain("בוצע!");
    expect(setValuesMock).not.toHaveBeenCalled();

    // 4. "כן" — מתבצע, רק על שתי הרשומות שהוצגו, עם התאריך שהוצג
    const seen4: RunModelParams[] = [];
    const r4 = await say("כן", [call("confirm_bulk_update", {}), text("x")], seen4);
    expect(seen4[0]!.system).toMatch(/עדכון קבוצתי ממתין לאישור/);
    expect(setValuesMock.mock.calls.map((c) => c[1])).toEqual(["102", "103"]);
    expect(setValuesMock.mock.calls[0]![2]).toEqual({ date__1: { date: SUNDAY } });
    expect(r4.reply).toMatch(/✅ עודכנו 2 משימות בהצלחה/);
    expect(r4.actions).toContain("📦 עדכון קבוצתי בוצע");

    // 5. "כן" שוב (לחיצה כפולה / retry) — לא נכתב שוב
    const r5 = await say("כן", [call("confirm_bulk_update", {}), text("x")]);
    expect(setValuesMock).toHaveBeenCalledTimes(2);
    expect(r5.reply).not.toMatch(/✅ עודכנו/);
  });

  it("המודל קורא confirm בלי שהמשתמש אישר ('מה זה יעשה?') — לא נכתב כלום", async () => {
    const say = conversation();
    await say("הצג את המשימות של איתן למחר", [call("query_records", { recordType: "tasks", assignees: ["איתן"], date: "מחר" }), text("x")]);
    await say("תעביר את כולן ליום ראשון", [call("prepare_bulk_update", { dueDate: "יום ראשון" }), text("x")]);
    const r = await say("רגע, מה זה יעשה לפרויקט רמות?", [call("confirm_bulk_update", {}), text("המשימות יעברו")]);
    expect(setValuesMock).not.toHaveBeenCalled();
    expect(r.reply).toBe("המשימות יעברו");
  });

  it("בלי הקשר שמור — 'תעביר את כולן' לא מנחש קבוצה", async () => {
    const say = conversation();
    const r = await say("תעביר את כולן ליום ראשון", [call("prepare_bulk_update", { dueDate: "יום ראשון" }), text("על אילו משימות מדובר?")]);
    expect(r.reply).toBe("על אילו משימות מדובר?");
    expect(readItemsMock).not.toHaveBeenCalled();
  });

  it("שיחה אחרת לא רואה את קבוצת התוצאות של השיחה הזו", async () => {
    const say1 = conversation(moti, "iso-A");
    await say1("הצג את המשימות של איתן למחר", [call("query_records", { recordType: "tasks", assignees: ["איתן"], date: "מחר" }), text("x")]);
    const say2 = conversation(moti, "iso-B");
    const seen: RunModelParams[] = [];
    await say2("תעביר את כולן ליום ראשון", [call("prepare_bulk_update", { dueDate: "יום ראשון" }), text("איזה?")], seen);
    expect(seen[0]!.system).not.toMatch(/קבוצת התוצאות האחרונה/);
    expect(readItemsMock).not.toHaveBeenCalled();
  });

  it("בלי מצב קבוצתי — ה-system prompt זהה לקודם (אין תוספת)", async () => {
    const say = conversation(moti, "plain-session");
    const seen: RunModelParams[] = [];
    await say("בוקר טוב", [text("בוקר טוב")], seen);
    expect(seen[0]!.system).not.toMatch(/פעולות קבוצתיות/);
  });
});

describe("הרשאות בצ'אט", () => {
  it("שרטטת שמבקשת לראות משימות של אחר — נדחה, Monday לא נקרא", async () => {
    const say = conversation(ruchama);
    const seen: RunModelParams[] = [];
    const r = await say("הצג את המשימות של איתן", [call("query_records", { recordType: "tasks", assignees: ["איתן"] }), text("אין לך הרשאה לזה")], seen);
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
    expect(r.reply).toBe("אין לך הרשאה לזה");
    const toolNames = seen[0]!.tools.map((t) => t.name);
    expect(toolNames).toContain("query_records");
    expect(toolNames).toContain("prepare_bulk_update"); // סטטוס על משימות של עצמה מותר; תאריך/אחראי נחסם פר-רשומה
  });
});

describe("שמירות שנוספו אחרי הבדיקה החיה (2026-10-21)", () => {
  it("אחרי תצוגה מקדימה — שום כלי נוסף באותו סבב (גם לא cancel), התצוגה נשארת בתוקף", async () => {
    const say = conversation();
    await say("הצג את המשימות של איתן למחר", [call("query_records", { recordType: "tasks", assignees: ["איתן"], date: "מחר" }), text("x")]);
    const seen: RunModelParams[] = [];
    const r = await say(
      "תעביר את כולן ליום ראשון",
      [call("prepare_bulk_update", { dueDate: "יום ראשון" }), call("cancel_bulk_update", {}), call("set_status", { itemId: "item_2_x", source: "project_stage", status: "בעבודה" }), text("x")],
      seen,
    );
    expect(r.reply).toMatch(/תצוגה מקדימה/);
    const results = JSON.stringify(seen.at(-1)!.messages);
    expect(results).toContain("אסור לקרוא לכלים נוספים");
    // התוכנית עדיין ממתינה — "כן" בהודעה הבאה מבצע
    await say("כן", [call("confirm_bulk_update", {}), text("x")]);
    expect(setValuesMock).toHaveBeenCalledTimes(3);
  });

  it("פעולה קבוצתית / המשך → SMART; הודעה רגילה → FAST", async () => {
    const say = conversation();
    const s1: RunModelParams[] = [];
    await say("בוקר טוב", [text("בוקר טוב")], s1);
    expect(s1[0]!.model).toBe("test-fast");
    const s2: RunModelParams[] = [];
    await say("תעביר את כל המשימות של מחר ליום ראשון", [text("איזה?")], s2);
    expect(s2[0]!.model).toBe("test-smart");
  });

  it("המודל 'חישב' תאריך שסותר את מה שהמשתמש אמר — נדחה, לא הוכנה תוכנית", async () => {
    const say = conversation();
    await say("הצג את המשימות של איתן למחר", [call("query_records", { recordType: "tasks", assignees: ["איתן"], date: "מחר" }), text("x")]);
    const wrong = DateTime.fromISO(SUNDAY).plus({ days: 1 }).toFormat("dd/MM/yyyy");
    const r = await say("תעביר את כולן ליום ראשון הבא", [call("prepare_bulk_update", { dueDate: wrong }), text("לא הצלחתי")]);
    expect(r.reply).toBe("לא הצלחתי");
    expect(readItemsMock).not.toHaveBeenCalled();
  });
});
