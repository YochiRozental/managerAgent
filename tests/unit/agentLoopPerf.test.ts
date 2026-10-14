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

  // ── onToolTiming (2026-10-14, הרחבה) — per-tool name/duration/ok, ללא טיימר נוסף ────────────

  it("onToolTiming נקרא פעם אחת לכל tool call, עם name/ok נכונים", async () => {
    let turn = 0;
    const fn: RunModelFn = async () => {
      turn += 1;
      if (turn === 1) {
        const calls: NormToolCall[] = [
          { id: "tc1", name: "tool_a", input: {} },
          { id: "tc2", name: "tool_b", input: {} },
        ];
        return {
          text: "",
          toolCalls: calls,
          assistantContent: calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
          usage: USAGE,
        };
      }
      return { text: "done", toolCalls: [], assistantContent: [{ type: "text", text: "done" }], usage: USAGE };
    };
    const timings: { name: string; durationMs: number; ok: boolean }[] = [];
    const r = await runAgentLoop({
      provider: "anthropic",
      model: "test",
      system: "s",
      maxTokens: 10,
      maxTurns: 4,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "tool_a", description: "x", parameters: { type: "object", properties: {} } },
        { name: "tool_b", description: "x", parameters: { type: "object", properties: {} } },
      ],
      executeToolCall: async (call) => {
        await sleep(call.name === "tool_a" ? 20 : 10);
        return { content: "{}", sideEffect: false };
      },
      onToolTiming: (name, durationMs, ok) => timings.push({ name, durationMs, ok }),
      _runModel: fn,
    });
    expect(timings).toHaveLength(2);
    expect(timings.map((t) => t.name).sort()).toEqual(["tool_a", "tool_b"]);
    expect(timings.every((t) => t.ok)).toBe(true);
    expect(timings.find((t) => t.name === "tool_a")!.durationMs).toBeGreaterThanOrEqual(15);
    // req #3 — אין "נספר פעמיים": סכום המדידות הפרטניות שווה בדיוק לסכום המצטבר הקיים.
    const sumIndividual = timings.reduce((s, t) => s + t.durationMs, 0);
    expect(Math.abs(sumIndividual - r.toolTimeMs)).toBeLessThan(0.01);
  });

  it("onToolTiming מדווח ok=false כש-executeToolCall זרק, בלי לשנות את זרימת הלולאה", async () => {
    let turn = 0;
    const fn: RunModelFn = async () => {
      turn += 1;
      if (turn === 1) {
        return { text: "", toolCalls: [{ id: "tc1", name: "broken", input: {} }], assistantContent: [{ type: "tool_use", id: "tc1", name: "broken", input: {} }], usage: USAGE };
      }
      return { text: "done", toolCalls: [], assistantContent: [{ type: "text", text: "done" }], usage: USAGE };
    };
    const timings: { name: string; ok: boolean }[] = [];
    const r = await runAgentLoop({
      provider: "anthropic",
      model: "test",
      system: "s",
      maxTokens: 10,
      maxTurns: 4,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "broken", description: "x", parameters: { type: "object", properties: {} } }],
      executeToolCall: async () => {
        throw new Error("כשל כלי מדומה");
      },
      onToolTiming: (name, _durationMs, ok) => timings.push({ name, ok }),
      _runModel: fn,
    });
    expect(timings).toEqual([{ name: "broken", ok: false }]);
    expect(r.text).toBe("done"); // הלולאה המשיכה כרגיל אחרי הכשל, כמו קודם
  });

  it("onToolTiming שעצמו זורק לא מפיל את הלולאה (best-effort, ר' docstring)", async () => {
    let turn = 0;
    const fn: RunModelFn = async () => {
      turn += 1;
      if (turn === 1) {
        return { text: "", toolCalls: [{ id: "tc1", name: "ok_tool", input: {} }], assistantContent: [{ type: "tool_use", id: "tc1", name: "ok_tool", input: {} }], usage: USAGE };
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
      tools: [{ name: "ok_tool", description: "x", parameters: { type: "object", properties: {} } }],
      executeToolCall: async () => ({ content: "{}", sideEffect: false }),
      onToolTiming: () => {
        throw new Error("callback ניטור שבור");
      },
      _runModel: fn,
    });
    expect(r.text).toBe("done");
    expect(r.errored).toBe(false);
    expect(r.toolCallCount).toBe(1);
  });

  it("בלי onToolTiming (channel שלא מעביר אותו, כמו orchestrator.ts) — ההתנהגות זהה לקודם", async () => {
    const r = await runAgentLoop({
      provider: "anthropic",
      model: "test",
      system: "s",
      maxTokens: 10,
      maxTurns: 3,
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      executeToolCall: async () => ({ content: "{}", sideEffect: false }),
      _runModel: textModel(5),
    });
    expect(r.text).toBe("תשובה");
    expect(r.errored).toBe(false);
  });
});
