/**
 * ניטור ביצועים (2026-10-14) — agentLoop.ts's aiTimeMs/aiCallCount/toolTimeMs. שעון מונוטוני
 * מוזרק בעקיפין: _runModel/executeToolCall מדומים עם delay מבוקר (setTimeout), אין קריאת AI אמיתית.
 */

import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../../src/ai/agentLoop.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelResult } from "../../src/ai/providers/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };

function textModel(delayMs: number, text = "תשובה"): RunModelFn {
  return async () => {
    await sleep(delayMs);
    return { text, toolCalls: [], assistantContent: [{ type: "text", text }], usage: USAGE } satisfies RunModelResult;
  };
}

describe("agentLoop — ניטור ביצועים", () => {
  it("קריאת מודל יחידה בלי כלים: aiCallCount=1, aiTimeMs>=delay, toolTimeMs=0", async () => {
    const r = await runAgentLoop({
      provider: "anthropic",
      model: "test",
      system: "s",
      maxTokens: 10,
      maxTurns: 3,
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      executeToolCall: async () => ({ content: "{}", sideEffect: false }),
      _runModel: textModel(30),
    });
    expect(r.aiCallCount).toBe(1);
    expect(r.aiTimeMs).toBeGreaterThanOrEqual(25);
    expect(r.toolTimeMs).toBe(0);
    expect(r.toolCallCount).toBe(0);
  });

  it("סבב אחד עם tool_use: toolTimeMs>=delay הכלי, בנפרד מ-aiTimeMs", async () => {
    let turn = 0;
    const fn: RunModelFn = async () => {
      turn += 1;
      if (turn === 1) {
        const tc: NormToolCall = { id: "tc1", name: "do_thing", input: {} };
        return { text: "", toolCalls: [tc], assistantContent: [{ type: "tool_use", id: "tc1", name: "do_thing", input: {} }], usage: USAGE };
      }
      return { text: "סיימתי", toolCalls: [], assistantContent: [{ type: "text", text: "סיימתי" }], usage: USAGE };
    };
    const r = await runAgentLoop({
      provider: "anthropic",
      model: "test",
      system: "s",
      maxTokens: 10,
      maxTurns: 4,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "do_thing", description: "x", parameters: { type: "object", properties: {} } }],
      executeToolCall: async () => {
        await sleep(40);
        return { content: "{}", sideEffect: true };
      },
      _runModel: fn,
    });
    expect(r.aiCallCount).toBe(2); // שני סבבים = שתי קריאות מודל
    expect(r.toolCallCount).toBe(1);
    expect(r.sideEffects).toBe(1);
    expect(r.toolTimeMs).toBeGreaterThanOrEqual(35);
    // aiTimeMs לא "בולע" את זמן הכלי — הן נמדדות בנפרד
    expect(r.toolTimeMs).toBeGreaterThan(r.aiTimeMs - 10);
  });

  it("קריאת מודל שנכשלת: עדיין נספרת aiCallCount=1 וזמן aiTimeMs>0 (errored=true)", async () => {
    const fn: RunModelFn = async () => {
      await sleep(20);
      throw new Error("מוק: כשל מודל");
    };
    const r = await runAgentLoop({
      provider: "anthropic",
      model: "test",
      system: "s",
      maxTokens: 10,
      maxTurns: 3,
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      executeToolCall: async () => ({ content: "{}", sideEffect: false }),
      _runModel: fn,
    });
    expect(r.errored).toBe(true);
    expect(r.aiCallCount).toBe(1);
    expect(r.aiTimeMs).toBeGreaterThanOrEqual(15);
    expect(r.toolTimeMs).toBe(0);
  });

  it("כלי שנכשל (זרק): עדיין נמדד זמן ונספר toolCallCount", async () => {
    let turn = 0;
    const fn: RunModelFn = async () => {
      turn += 1;
      if (turn === 1) {
        return { text: "", toolCalls: [{ id: "tc1", name: "x", input: {} }], assistantContent: [{ type: "tool_use", id: "tc1", name: "x", input: {} }], usage: USAGE };
      }
      return { text: "done", toolCalls: [], assistantContent: [{ type: "text", text: "done" }], usage: USAGE };
    };
    const r = await runAgentLoop({
      provider: "anthropic",
      model: "test",
      system: "s",
      maxTokens: 10,
      maxTurns: 4,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "x", description: "x", parameters: { type: "object", properties: {} } }],
      executeToolCall: async () => {
        await sleep(15);
        throw new Error("כשל כלי מדומה");
      },
      _runModel: fn,
    });
    expect(r.toolCallCount).toBe(1);
    expect(r.sideEffects).toBe(0);
    expect(r.toolTimeMs).toBeGreaterThanOrEqual(10);
  });
});
