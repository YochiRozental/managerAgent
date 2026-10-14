/**
 * ניטור ביצועים (2026-10-14) — RoutedAgentResult.perf: צבירה על פני fallback FAST→SMART.
 * בדיוק עיקרון tests/unit/aiProviders.test.ts (_runModel מוזרק, אין קריאת AI אמיתית).
 */

import { describe, expect, it } from "vitest";
import { runRoutedAgent } from "../../src/ai/routedAgent.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { RunModelResult } from "../../src/ai/providers/types.js";
import type { TierConfig } from "../../src/ai/tierConfig.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const FAST: TierConfig = { provider: "anthropic", model: "test-fast" };
const SMART: TierConfig = { provider: "anthropic", model: "test-smart" };

describe("runRoutedAgent — ניטור ביצועים", () => {
  it("ניסיון FAST יחיד שמצליח: attempts=1, aiCallCount תואם למה שה-loop דיווח", async () => {
    const fn: RunModelFn = async () => {
      await sleep(20);
      return { text: "עדכנתי", toolCalls: [], assistantContent: [{ type: "text", text: "עדכנתי" }], usage: USAGE } satisfies RunModelResult;
    };
    const routed = await runRoutedAgent({
      useCase: "ops_chat",
      latestMessage: "עדכן שסיימתי",
      historyLength: 1,
      canSeeAllWork: false,
      _config: { fast: FAST, smart: SMART, costLogging: false },
      _runModel: fn,
      buildLoop: () => ({
        system: "s",
        maxTokens: 10,
        maxTurns: 3,
        messages: [{ role: "user", content: "עדכן שסיימתי" }],
        tools: [],
        executeToolCall: async () => ({ content: "{}", sideEffect: false }),
      }),
    });
    expect(routed.perf.attempts).toBe(1);
    expect(routed.perf.aiCallCount).toBe(1);
    expect(routed.perf.aiTimeMs).toBeGreaterThanOrEqual(15);
    expect(routed.perf.toolCallCount).toBe(0);
    expect(routed.fallbackUsed).toBe(false);
  });

  it("FAST נכשל (אין tool_use, אין טקסט) בלי תופעות לוואי → fallback ל-SMART: perf מצטבר על שני הניסיונות", async () => {
    const fn: RunModelFn = async (p) => {
      await sleep(10);
      if (p.model === "test-fast") {
        return { text: "", toolCalls: [], assistantContent: [], usage: USAGE } satisfies RunModelResult; // empty text → failed
      }
      return { text: "בוצע בהצלחה", toolCalls: [], assistantContent: [{ type: "text", text: "בוצע בהצלחה" }], usage: USAGE };
    };
    const routed = await runRoutedAgent({
      useCase: "ops_chat",
      latestMessage: "תנתח לי מה עדיף", // מילת-מפתח אנליטית → נתב ישר ל-smart? נבדוק forceTier=fast במפורש
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast", // מכריח ניתוב ל-fast כדי לבדוק את מסלול ה-fallback במפורש, לא את ה-router
      _config: { fast: FAST, smart: SMART, costLogging: false },
      _runModel: fn,
      buildLoop: () => ({
        system: "s",
        maxTokens: 10,
        maxTurns: 3,
        messages: [{ role: "user", content: "x" }],
        tools: [],
        executeToolCall: async () => ({ content: "{}", sideEffect: false }),
      }),
    });
    expect(routed.fallbackUsed).toBe(true);
    expect(routed.perf.attempts).toBe(2);
    expect(routed.perf.aiCallCount).toBe(2); // קריאה אחת ב-fast + קריאה אחת ב-smart
    expect(routed.perf.aiTimeMs).toBeGreaterThanOrEqual(15); // סכום שני הניסיונות, לא רק האחרון
    expect(routed.outcome.text).toBe("בוצע בהצלחה");
  });

  it("FAST נכשל אבל *כן* היו תופעות לוואי → אין fallback: perf רק מניסיון אחד", async () => {
    let execCount = 0;
    const fn: RunModelFn = async (p) => {
      await sleep(10);
      if (p.model === "test-fast" && execCount === 0) {
        return { text: "", toolCalls: [{ id: "tc1", name: "do_thing", input: {} }], assistantContent: [{ type: "tool_use", id: "tc1", name: "do_thing", input: {} }], usage: USAGE };
      }
      return { text: "", toolCalls: [], assistantContent: [], usage: USAGE }; // אחרי tool_use — טקסט ריק (לא "נכשל" מבחינת side effects)
    };
    const routed = await runRoutedAgent({
      useCase: "ops_chat",
      latestMessage: "x",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: { fast: FAST, smart: SMART, costLogging: false },
      _runModel: fn,
      buildLoop: () => ({
        system: "s",
        maxTokens: 10,
        maxTurns: 3,
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "do_thing", description: "x", parameters: { type: "object", properties: {} } }],
        executeToolCall: async () => {
          execCount += 1;
          return { content: "{}", sideEffect: true }; // תופעת לוואי אמיתית
        },
      }),
    });
    expect(routed.fallbackUsed).toBe(false); // תופעת לוואי אמיתית → אין fallback, גם אם הטקסט ריק
    expect(routed.perf.attempts).toBe(1);
    expect(routed.perf.toolCallCount).toBe(1);
  });
});
