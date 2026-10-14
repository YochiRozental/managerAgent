/**
 * Lazy loading של fetchUserOpsTasks (2026-10-14) — מטריצת ההתנהגות המבוקשת: שאלה פשוטה, כלי שאינו
 * תלוי ב-tasks, כלי שתלוי ב-tasks, שתי קריאות כלי (promise משותף — לא fetch כפול), תרחיש refresh
 * (נכונות הנתונים אחרי כתיבה), וכשל Monday שלא פוגע בבקשה שלא זקוקה לנתוניו.
 *
 * READ-ONLY מול Monday (fetchUserOpsTasks ו-updateTask מדומים ומבוקרים per-test — אין Monday אמיתי,
 * אין כתיבה אמיתית). אפס קריאת AI אמיתית — _runModel מוזרק בכל תרחיש.
 */

import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchUserOpsTasksMock, updateTaskMock } = vi.hoisted(() => ({
  fetchUserOpsTasksMock: vi.fn(),
  updateTaskMock: vi.fn(),
}));

vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchUserOpsTasks: fetchUserOpsTasksMock,
    getProjectNextAction: async () => null,
    matchProjectsByQuery: () => [],
  };
});
// mark_done (AgentTool משותף) קורא ל-doUpdateTask — מוזרק כאן כדי לא לגעת ב-Monday האמיתי,
// בדיוק העיקרון של tests/integration/attendanceIncident1013.test.ts's AGENT_TOOLS mock.
vi.mock(import("../../src/ops/agentTools.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, AGENT_TOOLS: actual.buildAgentTools({ updateTask: updateTaskMock as unknown as typeof actual.updateTask }) };
});

import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelResult } from "../../src/ai/providers/types.js";
import type { OpsTask } from "../../src/integrations/monday/opsRead.js";

const dov = resolveUserByKey("dov")!;
const msg = (text: string): ChatMessage[] => [{ role: "user", content: text }];
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };

function task(itemId: string, name: string): OpsTask {
  return {
    source: "general",
    itemId,
    name,
    url: "https://example.test/t",
    context: "משימות משרד",
    status: "לביצוע",
    assignees: dov.name,
  };
}

function toolCallStep(name: string, input: Record<string, unknown> = {}): RunModelResult {
  const id = `tc-${name}`;
  return {
    text: "",
    toolCalls: [{ id, name, input }],
    assistantContent: [{ type: "tool_use", id, name, input }],
    usage: USAGE,
  };
}
function textStep(text: string): RunModelResult {
  return { text, toolCalls: [], assistantContent: [{ type: "text", text }], usage: USAGE };
}

/** מפעיל סקריפט של RunModelResult-ים לפי סדר, בלי תלות ב-model name (כל הבדיקות כאן fast בלבד). */
function scriptedRunModel(steps: RunModelResult[]): RunModelFn {
  let i = 0;
  return async () => steps[Math.min(i++, steps.length - 1)]!;
}

beforeEach(() => {
  fetchUserOpsTasksMock.mockReset();
  fetchUserOpsTasksMock.mockResolvedValue([]);
  updateTaskMock.mockReset();
  updateTaskMock.mockResolvedValue({ ok: true, message: "עודכן" });
});

describe("lazy loading — fetchUserOpsTasks", () => {
  it("1. שאלה פשוטה (בלי tool_use כלל) — Monday לא נקרא בכלל", async () => {
    const result = await runOpsChat(dov, msg("בוקר טוב"), {
      session: "lazy-s1",
      clientMessageId: "lazy-cmid-1",
      _runModel: scriptedRunModel([textStep("בוקר טוב גם לך")]),
      _config: TEST_CONFIG,
    });
    expect(result.reply).toBe("בוקר טוב גם לך");
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
  });

  it("2. כלי שלא תלוי ב-tasks (list_my_commitments) — רץ בהצלחה, Monday לא נקרא", async () => {
    const result = await runOpsChat(dov, msg("מה הבטחתי?"), {
      session: "lazy-s2",
      clientMessageId: "lazy-cmid-2",
      _runModel: scriptedRunModel([toolCallStep("list_my_commitments"), textStep("אין התחייבויות פתוחות")]),
      _config: TEST_CONFIG,
    });
    expect(result.reply).toBe("אין התחייבויות פתוחות");
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
  });

  it("3. כלי שתלוי ב-tasks (find_task) — Monday נקרא פעם אחת, והתוצאה נכונה", async () => {
    fetchUserOpsTasksMock.mockResolvedValueOnce([task("t1", "התכניות של בלומינג")]);
    const result = await runOpsChat(dov, msg("מצא את התכניות של בלומינג"), {
      session: "lazy-s3",
      clientMessageId: "lazy-cmid-3",
      _runModel: scriptedRunModel([toolCallStep("find_task", { query: "בלומינג" }), textStep("מצאתי")]),
      _config: TEST_CONFIG,
    });
    expect(result.reply).toBe("מצאתי");
    expect(fetchUserOpsTasksMock).toHaveBeenCalledTimes(1);
    expect(result.perf?.toolCalls.map((t) => t.name)).toEqual(["find_task"]);
  });

  it("4. שתי קריאות כלי התלויות ב-tasks באותו סבב — promise משותף, Monday נקרא פעם אחת בלבד", async () => {
    fetchUserOpsTasksMock.mockResolvedValueOnce([task("t1", "משימה א"), task("t2", "משימה ב")]);
    const result = await runOpsChat(dov, msg("מצא לי שתי משימות"), {
      session: "lazy-s4",
      clientMessageId: "lazy-cmid-4",
      _runModel: scriptedRunModel([
        {
          text: "",
          toolCalls: [
            { id: "tc1", name: "find_task", input: { query: "א" } },
            { id: "tc2", name: "find_task", input: { query: "ב" } },
          ],
          assistantContent: [
            { type: "tool_use", id: "tc1", name: "find_task", input: { query: "א" } },
            { type: "tool_use", id: "tc2", name: "find_task", input: { query: "ב" } },
          ],
          usage: USAGE,
        },
        textStep("מצאתי את שתיהן"),
      ]),
      _config: TEST_CONFIG,
    });
    expect(result.reply).toBe("מצאתי את שתיהן");
    expect(fetchUserOpsTasksMock).toHaveBeenCalledTimes(1); // לא שתי שליפות עבור שני ה-tool calls
    expect(result.perf?.toolCalls).toHaveLength(2);
  });

  it("5. תרחיש refresh: mark_done מרענן את tasks, וקריאת find_task הבאה באותו סבב רואה את הנתון המעודכן", async () => {
    // קריאה ראשונה (lazy load, מופעלת ע"י mark_done's needsTasks) — "לפני". קריאה שנייה (refresh
    // המפורש אחרי הכתיבה) — "אחרי", עם משימה חדשה שלא היתה קודם.
    fetchUserOpsTasksMock
      .mockResolvedValueOnce([task("t1", "משימה ישנה")])
      .mockResolvedValueOnce([task("t2", "משימה חדשה-אחרי-רענון")]);

    const result = await runOpsChat(dov, msg("סיימתי את t1, ומה עם המשימה החדשה?"), {
      session: "lazy-s5",
      clientMessageId: "lazy-cmid-5",
      _runModel: scriptedRunModel([
        toolCallStep("mark_done", { itemId: "t1", source: "general" }),
        toolCallStep("find_task", { query: "חדשה" }),
        textStep("סיימתי וגם מצאתי"),
      ]),
      _config: TEST_CONFIG,
    });

    expect(result.reply).toBe("סיימתי וגם מצאתי");
    expect(updateTaskMock).toHaveBeenCalledTimes(1); // הכתיבה האמיתית (מדומה) ל-Monday קרתה
    // בדיוק שתי שליפות: lazy load אחת (mark_done's needsTasks) + refresh אחת (אחרי הכתיבה) —
    // לא שלוש (find_task לא גרם לשליפה שלישית, כי tasksPromise כבר היה resolved מה-refresh).
    expect(fetchUserOpsTasksMock).toHaveBeenCalledTimes(2);
    // ה-action הסופית של mark_done כוללת את שם המשימה (lazy load הצליח לפני בניית ההודעה).
    expect(result.actions.some((a) => a.includes("משימה ישנה"))).toBe(true);
    // find_task (שרץ *אחרי* ה-refresh) מצא את המשימה המעודכנת, לא את הרשימה הישנה.
    expect(result.perf?.toolCalls.map((t) => t.name)).toEqual(["mark_done", "find_task"]);
  });

  it("6. כשל Monday — בקשה שלא זקוקה ל-tasks מצליחה כרגיל (req #9), בקשה שכן זקוקה נכשלת בכלי בלבד (לא בכל הבקשה)", async () => {
    const boom = new Error("Monday timeout מדומה");
    fetchUserOpsTasksMock.mockRejectedValue(boom);

    // 6a — שאלה פשוטה: Monday כלל לא מנוסה, אין השפעה.
    const simple = await runOpsChat(dov, msg("תודה"), {
      session: "lazy-s6a",
      clientMessageId: "lazy-cmid-6a",
      _runModel: scriptedRunModel([textStep("בשמחה")]),
      _config: TEST_CONFIG,
    });
    expect(simple.reply).toBe("בשמחה");
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();

    // 6b — find_task (תלוי ב-tasks) עם Monday למטה: הכלי עצמו נכשל בעדינות (tool_result עם שגיאה),
    // הבקשה *כולה* לא נופלת — ה-loop ממשיך לתשובה הסופית הסקריפטית.
    const result = await runOpsChat(dov, msg("מצא את X"), {
      session: "lazy-s6b",
      clientMessageId: "lazy-cmid-6b",
      _runModel: scriptedRunModel([toolCallStep("find_task", { query: "X" }), textStep("לא הצלחתי, יש תקלה")]),
      _config: TEST_CONFIG,
    });
    expect(result.reply).toBe("לא הצלחתי, יש תקלה");
    expect(result.perf?.prepSteps[0]).toMatchObject({ name: "fetch_user_ops_tasks", ok: false });
  });

  // ── בדיקת בטיחות (audit לפני פריסה, 2026-10-14): mark_done/set_status מצליחים ב-Monday, אבל
  //    ensureTasksLoaded נכשל *אחרי* (לצורך הודעת התצוגה בלבד) — ודא שהתוצאה המדווחת למודל ולמשתמש
  //    היא הצלחה אמיתית, לא כישלון מטעה. בלי ה-try/catch ב-onExecuted (ר' chat.ts), dispatchToolDefinition
  //    היה תופס את החריגה הזו כ"הכלי נכשל" (sideEffect:false, content="שגיאה: ...") גם כש-tool.execute
  //    (הכתיבה האמיתית) כבר הצליחה.
  it("7. בטיחות: mark_done מצליח ב-Monday, ensureTasksLoaded נכשל לאחר מכן — tool_result ו-actions משקפים הצלחה, לא כישלון", async () => {
    // mockRejectedValueOnce — רק הקריאה הראשונה (lazy load של mark_done's needsTasks) נכשלת;
    // refresh() (הקריאה השנייה, אחרי הכתיבה) מצליחה כרגיל (ברירת המחדל מ-beforeEach).
    fetchUserOpsTasksMock.mockRejectedValueOnce(new Error("Monday timeout מדומה — שליפת tasks לתצוגה"));
    updateTaskMock.mockResolvedValue({ ok: true, message: "סומן כבוצע" }); // הכתיבה האמיתית מצליחה

    let toolResultContent: string | null = null;
    let turn = 0;
    const fn: RunModelFn = async (params) => {
      turn += 1;
      if (turn === 1) {
        return toolCallStep("mark_done", { itemId: "t1", source: "general" });
      }
      // turn 2 — תופס את tool_result שהמודל *באמת* קיבל מהסבב הקודם (לא מדומה/מחושב בנפרד).
      const lastMsg = params.messages[params.messages.length - 1]!;
      const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
      const tr = blocks.find((b) => b.type === "tool_result") as { content: string } | undefined;
      toolResultContent = tr?.content ?? null;
      return textStep("סימנתי בוצע");
    };

    const result = await runOpsChat(dov, msg("סיימתי את t1"), {
      session: "lazy-s7",
      clientMessageId: "lazy-cmid-7",
      _runModel: fn,
      _config: TEST_CONFIG,
    });

    // 1) tool_result שהמודל קיבל חייב לשקף הצלחה אמיתית — לא "שגיאה: ..." (למרות שה-lazy load
    //    לתצוגה נכשל). dispatchToolDefinition מחזיר sideEffect:true + content=JSON של tool.execute
    //    רק אם onExecuted *לא* זרק — זה מה שה-try/catch המקומי ב-chat.ts מבטיח.
    expect(toolResultContent).not.toBeNull();
    expect(toolResultContent).not.toMatch(/שגיאה/);
    expect(toolResultContent).toContain("סומן כבוצע"); // תוצאת tool.execute האמיתית, JSON.stringify
    // 2) actions (המוצג בחלונית) גם הוא הודעת הצלחה — לא נופל (findTask על tasks ריק → itemId גולמי,
    //    אבל עדיין "✅ ... — בוצע", לא "שגיאה").
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatch(/^✅/);
    expect(result.actions[0]).not.toMatch(/שגיאה/);
    // 3) התשובה הסופית (מהמודל, בתרחיש אמיתי הייתה מבוססת על ה-tool_result האמיתי) — גם היא לא כישלון.
    expect(result.reply).toBe("סימנתי בוצע");
    // 4) refresh() עדיין רץ בהצלחה (הקריאה השנייה ל-mock, שלא הוגדרה להיכשל).
    expect(fetchUserOpsTasksMock).toHaveBeenCalledTimes(2);
  });
});
