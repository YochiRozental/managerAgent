/**
 * שכבת ה-Provider (תצורה, עלות, תרגום tool-calling, ניתוב בין-ספקים, fallback) — הועבר אחד-לאחד
 * מ-scripts/test-ai-providers.ts (40 בדיקות, הסקריפט הישן הוסר).
 * המודל מוזרק (_runModel) — אין קריאת AI אמיתית; ה-SDK לא נוצר כלל.
 */

import { describe, expect, it } from "vitest";
import { resolveAiConfig, type TierConfig } from "../../src/ai/tierConfig.js";
import { getProvider, isProviderName } from "../../src/ai/providers/index.js";
import { estimateCostUsd, MODEL_PRICING } from "../../src/ai/pricing.js";
import { addUsage, newUsageAcc } from "../../src/ai/models.js";
import { runRoutedAgent } from "../../src/ai/routedAgent.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelResult } from "../../src/ai/providers/types.js";
import { fromAnthropicResponse, toAnthropicMessages, toAnthropicTools } from "../../src/ai/providers/anthropic.js";
import { fromOpenAiResponse, toOpenAiMessages, toOpenAiTools } from "../../src/ai/providers/openai.js";

// ─────────────────────────── מוק provider ───────────────────────────
type ScriptStep = { text: string } | { toolCalls: { name: string; input?: unknown }[] } | { error: true };

function makeFakeRunModel(scriptByModel: Record<string, ScriptStep[]>) {
  const calls: { provider: string; model: string }[] = [];
  const cursor: Record<string, number> = {};
  const fn: RunModelFn = async (params) => {
    calls.push({ provider: params.provider, model: params.model });
    const script = scriptByModel[params.model] ?? [{ text: "מוק" }];
    const i = cursor[params.model] ?? 0;
    cursor[params.model] = i + 1;
    const step = script[Math.min(i, script.length - 1)]!;
    if ("error" in step) throw new Error(`מוק: שגיאת מודל [${params.provider}/${params.model}]`);
    const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };
    if ("toolCalls" in step) {
      const tcs: NormToolCall[] = step.toolCalls.map((t, k) => ({ id: `tc_${i}_${k}`, name: t.name, input: t.input ?? {} }));
      return {
        text: "",
        toolCalls: tcs,
        assistantContent: tcs.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })),
        usage,
      } satisfies RunModelResult;
    }
    return { text: step.text, toolCalls: [], assistantContent: [{ type: "text", text: step.text }], usage };
  };
  return { fn, calls };
}

async function runScenario(opts: {
  fast: TierConfig;
  smart: TierConfig;
  scripts: Record<string, ScriptStep[]>;
  message: string;
  toolSideEffect?: boolean;
}) {
  const { fn, calls } = makeFakeRunModel(opts.scripts);
  let execCount = 0;
  const routed = await runRoutedAgent({
    useCase: "ops_chat",
    latestMessage: opts.message,
    historyLength: 2,
    canSeeAllWork: false,
    _config: { fast: opts.fast, smart: opts.smart, costLogging: false },
    _runModel: fn,
    buildLoop: () => ({
      system: "test",
      maxTokens: 100,
      maxTurns: 4,
      messages: [{ role: "user", content: opts.message }],
      tools: [{ name: "do_thing", description: "x", parameters: { type: "object", properties: {} } }],
      executeToolCall: async () => {
        execCount += 1;
        return { content: "{}", sideEffect: opts.toolSideEffect ?? true };
      },
    }),
  });
  return { routed, modelCalls: calls, execCount: () => execCount };
}

const AN_FAST: TierConfig = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
const AN_SMART: TierConfig = { provider: "anthropic", model: "claude-sonnet-5" };
const OAI_FAST: TierConfig = { provider: "openai", model: "gpt-5.4-mini" };
const OAI_SMART: TierConfig = { provider: "openai", model: "gpt-5" };
const SIMPLE = "עדכן שסיימתי את המשימה";
const COMPLEX = "תנתח לי מה עדיף להתחיל היום ולמה";

// ═══ תצורה ═══
describe("תצורה", () => {
  const def = resolveAiConfig({});
  it("ברירת מחדל FAST = anthropic / claude-haiku-4-5-20251001", () =>
    expect(def.fast).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }));
  it("ברירת מחדל SMART = anthropic / claude-sonnet-5", () =>
    expect(def.smart).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" }));

  const mixed = resolveAiConfig({
    AI_FAST_PROVIDER: "openai",
    AI_FAST_MODEL: "gpt-5.4-mini",
    AI_SMART_PROVIDER: "anthropic",
    AI_SMART_MODEL: "claude-sonnet-5",
  });
  it("env: FAST → openai/gpt-5.4-mini", () => expect(mixed.fast).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" }));
  it("env: SMART נשאר anthropic", () => expect(mixed.smart.provider).toBe("anthropic"));

  it("env: שני ה-tiers → openai (case-insensitive)", () => {
    const bothOai = resolveAiConfig({ AI_FAST_PROVIDER: "OpenAI", AI_SMART_PROVIDER: "openai", AI_SMART_MODEL: "gpt-5" });
    expect(bothOai.fast.provider).toBe("openai");
    expect(bothOai.smart.provider).toBe("openai");
  });
  it("alias ישן MODEL_FAST/MODEL_SMART עדיין עובד", () => {
    const legacy = resolveAiConfig({ MODEL_FAST: "claude-legacy", MODEL_SMART: "claude-legacy-2" });
    expect(legacy.fast.model).toBe("claude-legacy");
    expect(legacy.smart.model).toBe("claude-legacy-2");
  });
  it("AI_FAST_MODEL ריק → ברירת מחדל", () =>
    expect(resolveAiConfig({ AI_FAST_MODEL: "" }).fast.model).toBe("claude-haiku-4-5-20251001"));
  it("AI_COST_LOGGING=false מכבה", () => expect(resolveAiConfig({ AI_COST_LOGGING: "false" }).costLogging).toBe(false));
  it("provider לא תקין → שגיאה ברורה שמזכירה 'gemini'", () =>
    expect(() => resolveAiConfig({ AI_FAST_PROVIDER: "gemini" })).toThrow("gemini"));
  it("provider רווחים בלבד → ברירת מחדל (לא שגיאה)", () =>
    expect(resolveAiConfig({ AI_SMART_PROVIDER: "  " }).smart.provider).toBe("anthropic"));
  it("isProviderName", () => {
    expect(isProviderName("anthropic")).toBe(true);
    expect(isProviderName("openai")).toBe(true);
    expect(isProviderName("x")).toBe(false);
  });
  it("getProvider לספק לא מוכר → שגיאה", () => expect(() => getProvider("gemini" as never)).toThrow("לא מוכר"));
  it("getProvider מחזיר את הספק הנכון", () => {
    expect(getProvider("anthropic").name).toBe("anthropic");
    expect(getProvider("openai").name).toBe("openai");
  });
});

// ═══ עלות ═══
describe("עלות", () => {
  const u = newUsageAcc();
  addUsage(u, { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 });
  it("Haiku 4.5: 1M+1M = $1 + $5 = $6", () => expect(estimateCostUsd("claude-haiku-4-5-20251001", u)).toBe(6));
  it("Sonnet 5: 1M+1M = $2 + $10 = $12 (מחיר מעודכן)", () => expect(estimateCostUsd("claude-sonnet-5", u)).toBe(12));
  it("GPT-5.4 mini: 1M+1M = $0.75 + $4.50 = $5.25", () => expect(estimateCostUsd("gpt-5.4-mini", u)).toBe(5.25));
  it("מודל לא במחירון → null (לא ממציאים מחיר)", () => expect(estimateCostUsd("מודל-דמיוני", u)).toBeNull());
  it("מחירון מרכזי כולל GPT-5.4 mini ו-Sonnet 5", () => {
    expect(MODEL_PRICING).toHaveProperty(["gpt-5.4-mini"]);
    expect(MODEL_PRICING).toHaveProperty(["claude-sonnet-5"]);
  });
  it("addUsage מצטבר על פני סבבים, addUsage(null) לא מפיל", () => {
    const acc = newUsageAcc();
    addUsage(acc, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 });
    addUsage(acc, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 });
    addUsage(acc, null);
    expect(acc).toMatchObject({ inputTokens: 200, outputTokens: 100, cachedInputTokens: 10 });
  });
});

// ═══ תרגום schema / messages ═══
describe("תרגום schema / messages", () => {
  const norm = [{ name: "t1", description: "d1", parameters: { type: "object", properties: { x: { type: "string" } } } }];
  it("toAnthropicTools → input_schema", () => {
    const anT = toAnthropicTools(norm);
    expect(anT[0]!.name).toBe("t1");
    expect((anT[0] as { input_schema: unknown }).input_schema).toBeTruthy();
  });
  it("toOpenAiTools → function.parameters", () => {
    const tool = toOpenAiTools(norm)[0]!;
    expect(tool.type).toBe("function");
    if (tool.type !== "function") return; // narrowing לטיפוס — ה-expect למעלה כבר נכשל במקרה כזה
    expect(tool.function.name).toBe("t1");
    expect(tool.function.parameters).toBeTruthy();
  });

  const convo = [
    { role: "user" as const, content: "שלום" },
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "רגע" },
        { type: "tool_use" as const, id: "c1", name: "t1", input: { x: "y" } },
      ],
    },
    { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "c1", content: "done" }] },
  ];
  it("toAnthropicMessages שומר על מבנה ה-blocks", () => {
    const anM = toAnthropicMessages(convo);
    expect(anM).toHaveLength(3);
    expect(Array.isArray(anM[1]!.content)).toBe(true);
  });
  const oaM = toOpenAiMessages("SYS", convo);
  it("toOpenAiMessages: system ראשון", () => expect(oaM[0]!.role).toBe("system"));
  it("toOpenAiMessages: tool_use → tool_calls", () => {
    const asst = oaM.find((m) => m.role === "assistant") as { tool_calls?: unknown[] } | undefined;
    expect(asst?.tool_calls).toHaveLength(1);
  });
  it("toOpenAiMessages: tool_result → role:tool עם tool_call_id", () => {
    const toolMsg = oaM.find((m) => m.role === "tool") as { tool_call_id?: string } | undefined;
    expect(toolMsg?.tool_call_id).toBe("c1");
  });

  it("fromAnthropicResponse: text + toolCalls + cached", () => {
    const r = fromAnthropicResponse({
      content: [
        { type: "text", text: "היי" },
        { type: "tool_use", id: "u1", name: "t1", input: { a: 1 } },
      ],
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 },
    } as never);
    expect(r.text).toBe("היי");
    expect(r.toolCalls[0]!.name).toBe("t1");
    expect(r.usage.cachedInputTokens).toBe(4);
  });
  it("fromOpenAiResponse: text + toolCalls (arguments מפורסר) + usage", () => {
    const r = fromOpenAiResponse({
      choices: [
        { message: { content: "שלום", tool_calls: [{ id: "o1", type: "function", function: { name: "t1", arguments: '{"a":2}' } }] } },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } },
    } as never);
    expect(r.text).toBe("שלום");
    expect(r.toolCalls[0]!.name).toBe("t1");
    expect((r.toolCalls[0]!.input as { a: number }).a).toBe(2);
    expect(r.usage.inputTokens).toBe(20);
    expect(r.usage.cachedInputTokens).toBe(5);
  });
  it("fromOpenAiResponse: arguments לא תקין → {} (לא קורס)", () => {
    const r = fromOpenAiResponse({
      choices: [{ message: { content: null, tool_calls: [{ id: "o2", type: "function", function: { name: "t1", arguments: "{bad" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    } as never);
    expect(JSON.stringify(r.toolCalls[0]!.input)).toBe("{}");
  });
});

// ═══ ניתוב והרצה בין ספקים ═══
describe("ניתוב והרצה", () => {
  it("1. FAST Anthropic — קריאה אחת, provider anthropic", async () => {
    const r = await runScenario({ fast: AN_FAST, smart: AN_SMART, message: SIMPLE, scripts: { [AN_FAST.model]: [{ text: "בוצע" }] } });
    expect(r.routed.tier).toBe("fast");
    expect(r.routed.provider).toBe("anthropic");
    expect(r.routed.outcome.text).toBe("בוצע");
    expect(r.routed.fallbackUsed).toBe(false);
    expect(r.modelCalls).toHaveLength(1);
  });
  it("2. SMART Anthropic — נותב ל-smart", async () => {
    const r = await runScenario({ fast: AN_FAST, smart: AN_SMART, message: COMPLEX, scripts: { [AN_SMART.model]: [{ text: "ניתוח" }] } });
    expect(r.routed.tier).toBe("smart");
    expect(r.routed.provider).toBe("anthropic");
    expect(r.modelCalls[0]!.model).toBe(AN_SMART.model);
  });
  it("3. FAST OpenAI (gpt-5.4-mini)", async () => {
    const r = await runScenario({ fast: OAI_FAST, smart: AN_SMART, message: SIMPLE, scripts: { [OAI_FAST.model]: [{ text: "ok" }] } });
    expect(r.routed.tier).toBe("fast");
    expect(r.routed.provider).toBe("openai");
    expect(r.routed.model).toBe("gpt-5.4-mini");
  });
  it("4. SMART OpenAI (gpt-5)", async () => {
    const r = await runScenario({ fast: AN_FAST, smart: OAI_SMART, message: COMPLEX, scripts: { [OAI_SMART.model]: [{ text: "analysis" }] } });
    expect(r.routed.tier).toBe("smart");
    expect(r.routed.provider).toBe("openai");
    expect(r.routed.model).toBe("gpt-5");
  });

  describe("5. FAST OpenAI נכשל → fallback ל-SMART Anthropic", () => {
    const run = runScenario({
      fast: OAI_FAST,
      smart: AN_SMART,
      message: SIMPLE,
      scripts: { [OAI_FAST.model]: [{ error: true }], [AN_SMART.model]: [{ text: "סונטה הצילה" }] },
    });
    it("5. FAST OpenAI נכשל → fallback ל-SMART Anthropic", async () => {
      const r = await run;
      expect(r.routed.fallbackUsed).toBe(true);
      expect(r.routed.provider).toBe("anthropic");
      expect(r.routed.model).toBe("claude-sonnet-5");
      expect(r.routed.outcome.text).toBe("סונטה הצילה");
    });
    it("5. בדיוק 2 קריאות: openai ואז anthropic", async () => {
      const r = await run;
      expect(r.modelCalls.map((c) => c.provider)).toEqual(["openai", "anthropic"]);
    });
  });

  it("6. FAST Anthropic נכשל → fallback ל-SMART OpenAI", async () => {
    const r = await runScenario({
      fast: AN_FAST,
      smart: OAI_SMART,
      message: SIMPLE,
      scripts: { [AN_FAST.model]: [{ error: true }], [OAI_SMART.model]: [{ text: "gpt הציל" }] },
    });
    expect(r.routed.fallbackUsed).toBe(true);
    expect(r.routed.provider).toBe("openai");
    expect(r.routed.outcome.text).toBe("gpt הציל");
  });

  describe("11a. tool call — הרצה אחת לכל קריאה", () => {
    const run = runScenario({
      fast: AN_FAST,
      smart: AN_SMART,
      message: SIMPLE,
      toolSideEffect: false,
      scripts: { [AN_FAST.model]: [{ toolCalls: [{ name: "do_thing" }] }, { toolCalls: [{ name: "do_thing" }] }, { text: "סוף" }] },
    });
    it("11. שתי קריאות כלי → הורצו פעמיים בדיוק (בלי כפילות, בלי לולאה)", async () => {
      const r = await run;
      expect(r.execCount()).toBe(2);
      expect(r.routed.outcome.text).toBe("סוף");
      expect(r.routed.fallbackUsed).toBe(false);
    });
    it("11. 3 סבבי מודל (כלי, כלי, טקסט) — הלולאה לא רצה מחדש על עצמה", async () =>
      expect((await run).modelCalls).toHaveLength(3));
  });

  describe("11b. כלי עם תופעת לוואי ואז שגיאה → אין fallback", () => {
    const run = runScenario({
      fast: AN_FAST,
      smart: AN_SMART,
      message: SIMPLE,
      toolSideEffect: true,
      scripts: { [AN_FAST.model]: [{ toolCalls: [{ name: "do_thing" }] }, { error: true }], [AN_SMART.model]: [{ text: "לא אמור לרוץ" }] },
    });
    it("11. כלי עם תופעת לוואי רץ ואז שגיאה → בלי fallback, הכלי רץ פעם אחת בלבד", async () => {
      const r = await run;
      expect(r.routed.fallbackUsed).toBe(false);
      expect(r.execCount()).toBe(1);
    });
    it("11. SMART לא נקרא אחרי תופעת לוואי", async () =>
      expect((await run).modelCalls.some((c) => c.model === AN_SMART.model)).toBe(false));
  });

  it("12. FAST הצליח → קריאת AI אחת בלבד, SMART לא נקרא", async () => {
    const r = await runScenario({ fast: AN_FAST, smart: OAI_SMART, message: SIMPLE, scripts: { [AN_FAST.model]: [{ text: "מיד" }] } });
    expect(r.modelCalls).toHaveLength(1);
    expect(r.routed.fallbackUsed).toBe(false);
    expect(r.modelCalls.some((c) => c.provider === "openai")).toBe(false);
  });
});
