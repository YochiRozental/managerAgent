/**
 * ניטור ביצועים (2026-10-14, הרחבה) — runOpsChat מקצה-לקצה: perf.prepSteps (fetchUserOpsTasks)
 * ו-perf.toolCalls (per-tool), כולל אי-כפילות מול toolTimeMs (req #3).
 *
 * audit lazy loading (2026-10-14, המשך): fetchUserOpsTasks הפך ל-lazy — שני התרחישים "prep תמיד
 * קיים" ו-"כשל מתפשט כרגיל" השתנו בכוונה (ר' tests/integration/lazyTasksLoading.test.ts למטריצה
 * המלאה של ההתנהגות החדשה). כאן נשארות רק הבדיקות שלא השתנו + עדכון מינימלי לשתיים שכן.
 *
 * READ-ONLY מול Monday (fetchUserOpsTasks מדומה ומבוקר per-test). אפס קריאת AI אמיתית — _runModel מוזרק.
 */

import "dotenv/config";
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchUserOpsTasksMock } = vi.hoisted(() => ({ fetchUserOpsTasksMock: vi.fn() }));
vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchUserOpsTasks: fetchUserOpsTasksMock,
    getProjectNextAction: async () => null,
    matchProjectsByQuery: () => [],
  };
});

import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelResult } from "../../src/ai/providers/types.js";

const dov = resolveUserByKey("dov")!;
const msg = (text: string): ChatMessage[] => [{ role: "user", content: text }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };

beforeEach(() => {
  fetchUserOpsTasksMock.mockReset();
  fetchUserOpsTasksMock.mockResolvedValue([]);
});

describe("runOpsChat — ניטור שלבים (prep + tool)", () => {
  it("lazy loading: תשובה בלי tool_use — prepSteps ריק, fetchUserOpsTasks לא נקרא בכלל", async () => {
    const fn: RunModelFn = async () => ({
      text: "בוצע",
      toolCalls: [],
      assistantContent: [{ type: "text", text: "בוצע" }],
      usage: USAGE,
    });
    const result = await runOpsChat(dov, msg("תעדכן שהתחלתי לעבוד על ההגשה"), {
      session: "steps-s1",
      clientMessageId: "steps-cmid-1",
      _runModel: fn,
      _config: TEST_CONFIG,
    });
    expect(result.perf?.prepSteps).toEqual([]);
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
  });

  it("prepSteps כולל fetch_user_ops_tasks עם ok=true ומשך אמיתי, כש-כלי שתלוי ב-tasks נקרא", async () => {
    fetchUserOpsTasksMock.mockImplementationOnce(async () => {
      await sleep(15);
      return [];
    });
    let turn = 0;
    const fn: RunModelFn = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          text: "",
          toolCalls: [{ id: "tc1", name: "find_task", input: { query: "x" } }],
          assistantContent: [{ type: "tool_use", id: "tc1", name: "find_task", input: { query: "x" } }],
          usage: USAGE,
        } satisfies RunModelResult;
      }
      return { text: "לא נמצא", toolCalls: [], assistantContent: [{ type: "text", text: "לא נמצא" }], usage: USAGE };
    };
    const result = await runOpsChat(dov, msg("מצא את המשימה של בלומינג"), {
      session: "steps-s1b",
      clientMessageId: "steps-cmid-1b",
      _runModel: fn,
      _config: TEST_CONFIG,
    });
    expect(fetchUserOpsTasksMock).toHaveBeenCalledTimes(1);
    expect(result.perf?.prepSteps).toHaveLength(1);
    expect(result.perf?.prepSteps[0]).toMatchObject({ name: "fetch_user_ops_tasks", ok: true });
    expect(result.perf!.prepSteps[0]!.durationMs).toBeGreaterThanOrEqual(10);
  });

  it("toolCalls כולל את הכלי שנקרא, ואין כפילות מול toolTimeMs המצטבר", async () => {
    let turn = 0;
    const fn: RunModelFn = async () => {
      turn += 1;
      if (turn === 1) {
        const tc: NormToolCall = { id: "tc1", name: "find_task", input: { query: "x" } };
        return {
          text: "",
          toolCalls: [tc],
          assistantContent: [{ type: "tool_use", id: "tc1", name: "find_task", input: { query: "x" } }],
          usage: USAGE,
        } satisfies RunModelResult;
      }
      return { text: "לא נמצא", toolCalls: [], assistantContent: [{ type: "text", text: "לא נמצא" }], usage: USAGE };
    };
    const result = await runOpsChat(dov, msg("מה המצב של בלומינג"), {
      session: "steps-s2",
      clientMessageId: "steps-cmid-2",
      _runModel: fn,
      _config: TEST_CONFIG,
    });
    expect(result.perf?.toolCalls).toHaveLength(1);
    expect(result.perf?.toolCalls[0]).toMatchObject({ name: "find_task", ok: true });
    // req #3 — אין "נספר פעמיים": סכום המדידות הפרטניות שווה בדיוק ל-toolTimeMs המצטבר הקיים.
    const sumIndividual = result.perf!.toolCalls.reduce((s, t) => s + t.durationMs, 0);
    expect(Math.abs(sumIndividual - result.perf!.toolTimeMs)).toBeLessThan(1);
  });

  it("fetchUserOpsTasks נכשל, בלי tool_use כלל → לא מנוסה בכלל (lazy), הבקשה מצליחה כרגיל", async () => {
    // תרחיש מקביל ל-tests/integration/lazyTasksLoading.test.ts's req #9 — כאן ברמת ה-perf בלבד.
    const boom = new Error("Monday timeout מדומה");
    fetchUserOpsTasksMock.mockRejectedValueOnce(boom);
    const fn: RunModelFn = async () => ({ text: "בוקר טוב גם לך", toolCalls: [], assistantContent: [{ type: "text", text: "בוקר טוב גם לך" }], usage: USAGE });
    const result = await runOpsChat(dov, msg("בוקר טוב"), {
      session: "steps-s3",
      clientMessageId: "steps-cmid-3",
      _runModel: fn,
      _config: TEST_CONFIG,
    });
    expect(result.reply).toBe("בוקר טוב גם לך");
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
    expect(result.perf?.prepSteps).toEqual([]);
  });

  it("בלי mondayUserId — אין prep/tool records (perf כולו undefined, כמו קודם)", async () => {
    const noMonday = { ...dov, mondayUserId: null };
    const result = await runOpsChat(noMonday, msg("שלום"), { session: "steps-s4" });
    expect(result.perf).toBeUndefined();
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
  });

  it("wiring ב-server/index.ts: endpoint חדש מוגן view:all_work, וכתיבה מרוכזת אחת (לא per-step)", () => {
    const serverSrc = fs.readFileSync(new URL("../../src/server/index.ts", import.meta.url), "utf-8");
    const idx = serverSrc.indexOf('"/api/perf/steps"');
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = serverSrc.slice(idx, idx + 700);
    expect(block).toMatch(/view:all_work/);
    expect(block).toMatch(/403/);
    expect(block).toMatch(/getChatPerfStepsForRequestSafe\(/);
    expect(serverSrc).toMatch(/recordChatPerfStepsSafe\(/);
    // לא קריאה גולמית (בלי Safe) מ-server/index.ts
    expect(serverSrc).not.toMatch(/recordChatPerfSteps\(/);
    // כתיבה אחת בלבד לכל בקשה (לא בתוך לולאה) — מחפשים שהקריאה מופיעה פעם אחת בקובץ
    const occurrences = serverSrc.match(/recordChatPerfStepsSafe\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("schema.sql: chat_perf_steps אין בה עמודת ארגומנטים/תוכן/תוצאה", () => {
    const schemaSrc = fs.readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf-8");
    const idx = schemaSrc.indexOf("CREATE TABLE IF NOT EXISTS chat_perf_steps");
    expect(idx).toBeGreaterThanOrEqual(0);
    const tableBlock = schemaSrc.slice(idx, schemaSrc.indexOf(");", idx) + 2);
    expect(tableBlock).not.toMatch(/\binput\b|\bargs\b|\bresult\b|\bcontent\b|\bmessage\b|\bproject\b|\bclient\b/i);
  });
});
