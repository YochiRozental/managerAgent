/**
 * בדיקת שכבת ה-Provider — תצורה, ניתוב בין-ספקים, fallback, ותרגום tool-calling.
 * הכל מקומי: ה-SDKים מוקאפים (אין קריאות API אמיתיות).
 * מריץ: npm run test:ai-providers
 */
import { resolveAiConfig, type TierConfig } from "../src/ai/tierConfig.js";
import { getProvider, isProviderName } from "../src/ai/providers/index.js";
import { estimateCostUsd, MODEL_PRICING } from "../src/ai/pricing.js";
import { addUsage, newUsageAcc } from "../src/ai/models.js";
import { runRoutedAgent } from "../src/ai/routedAgent.js";
import type { RunModelFn } from "../src/ai/agentLoop.js";
import type { NormToolCall, RunModelResult } from "../src/ai/providers/types.js";
import {
  fromAnthropicResponse,
  toAnthropicMessages,
  toAnthropicTools,
} from "../src/ai/providers/anthropic.js";
import {
  fromOpenAiResponse,
  toOpenAiMessages,
  toOpenAiTools,
} from "../src/ai/providers/openai.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) logger.info(`✅ ${msg}`);
  else {
    failures++;
    logger.error(`❌ ${msg}`);
  }
}
function assertThrows(fn: () => unknown, includes: string, msg: string) {
  try {
    fn();
    failures++;
    logger.error(`❌ ${msg} (לא נזרקה שגיאה)`);
  } catch (e) {
    const m = (e as Error).message;
    if (m.includes(includes)) logger.info(`✅ ${msg}`);
    else {
      failures++;
      logger.error(`❌ ${msg} — השגיאה לא הכילה "${includes}": ${m}`);
    }
  }
}

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
// דוגמה מרכזית: GPT-5.4 mini מול Claude Haiku (מה שיוכי רוצה להשוות)
const OAI_FAST: TierConfig = { provider: "openai", model: "gpt-5.4-mini" };
const OAI_SMART: TierConfig = { provider: "openai", model: "gpt-5" };
const SIMPLE = "עדכן שסיימתי את המשימה";
const COMPLEX = "תנתח לי מה עדיף להתחיל היום ולמה";

async function main() {
  // ═══ תצורה (7, 8, 9-ברירת מחדל) ═══
  logger.info("— תצורה —");
  const def = resolveAiConfig({});
  assert(
    def.fast.provider === "anthropic" && def.fast.model === "claude-haiku-4-5-20251001",
    "ברירת מחדל FAST = anthropic / claude-haiku-4-5-20251001",
  );
  assert(
    def.smart.provider === "anthropic" && def.smart.model === "claude-sonnet-5",
    "ברירת מחדל SMART = anthropic / claude-sonnet-5",
  );

  const mixed = resolveAiConfig({
    AI_FAST_PROVIDER: "openai",
    AI_FAST_MODEL: "gpt-5.4-mini",
    AI_SMART_PROVIDER: "anthropic",
    AI_SMART_MODEL: "claude-sonnet-5",
  });
  assert(mixed.fast.provider === "openai" && mixed.fast.model === "gpt-5.4-mini", "env: FAST → openai/gpt-5.4-mini");
  assert(mixed.smart.provider === "anthropic", "env: SMART נשאר anthropic");

  const bothOai = resolveAiConfig({ AI_FAST_PROVIDER: "OpenAI", AI_SMART_PROVIDER: "openai", AI_SMART_MODEL: "gpt-5" });
  assert(bothOai.fast.provider === "openai" && bothOai.smart.provider === "openai", "env: שני ה-tiers → openai (case-insensitive)");

  const legacy = resolveAiConfig({ MODEL_FAST: "claude-legacy", MODEL_SMART: "claude-legacy-2" });
  assert(legacy.fast.model === "claude-legacy" && legacy.smart.model === "claude-legacy-2", "alias ישן MODEL_FAST/MODEL_SMART עדיין עובד");

  assert(resolveAiConfig({ AI_FAST_MODEL: "" }).fast.model === "claude-haiku-4-5-20251001", "AI_FAST_MODEL ריק → ברירת מחדל");
  assert(resolveAiConfig({ AI_COST_LOGGING: "false" }).costLogging === false, "AI_COST_LOGGING=false מכבה");

  assertThrows(() => resolveAiConfig({ AI_FAST_PROVIDER: "gemini" }), "gemini", "provider לא תקין → שגיאה ברורה שמזכירה 'gemini'");
  assert(resolveAiConfig({ AI_SMART_PROVIDER: "  " }).smart.provider === "anthropic", "provider רווחים בלבד → ברירת מחדל (לא שגיאה)");
  assert(isProviderName("anthropic") && isProviderName("openai") && !isProviderName("x"), "isProviderName");
  assertThrows(() => getProvider("gemini" as never), "לא מוכר", "getProvider לספק לא מוכר → שגיאה");
  assert(getProvider("anthropic").name === "anthropic" && getProvider("openai").name === "openai", "getProvider מחזיר את הספק הנכון");

  // ═══ עלות (8) ═══
  logger.info("— עלות —");
  const u = newUsageAcc();
  addUsage(u, { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 });
  assert(estimateCostUsd("claude-haiku-4-5-20251001", u) === 6, "Haiku 4.5: 1M+1M = $1 + $5 = $6");
  assert(estimateCostUsd("claude-sonnet-5", u) === 12, "Sonnet 5: 1M+1M = $2 + $10 = $12 (מחיר מעודכן)");
  assert(estimateCostUsd("gpt-5.4-mini", u) === 5.25, "GPT-5.4 mini: 1M+1M = $0.75 + $4.50 = $5.25");
  assert(estimateCostUsd("מודל-דמיוני", u) === null, "מודל לא במחירון → null (לא ממציאים מחיר)");
  assert("gpt-5.4-mini" in MODEL_PRICING && "claude-sonnet-5" in MODEL_PRICING, "מחירון מרכזי כולל GPT-5.4 mini ו-Sonnet 5");

  const acc = newUsageAcc();
  addUsage(acc, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 });
  addUsage(acc, { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 });
  addUsage(acc, null);
  assert(acc.inputTokens === 200 && acc.outputTokens === 100 && acc.cachedInputTokens === 10, "addUsage מצטבר על פני סבבים, addUsage(null) לא מפיל");

  // ═══ תרגום tool schema + messages (9, 10) ═══
  logger.info("— תרגום schema / messages —");
  const norm = [{ name: "t1", description: "d1", parameters: { type: "object", properties: { x: { type: "string" } } } }];
  const anT = toAnthropicTools(norm);
  assert(anT[0]!.name === "t1" && !!(anT[0] as { input_schema: unknown }).input_schema, "toAnthropicTools → input_schema");
  const oaT = toOpenAiTools(norm);
  assert(oaT[0]!.type === "function" && oaT[0]!.function.name === "t1" && !!oaT[0]!.function.parameters, "toOpenAiTools → function.parameters");

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
  const anM = toAnthropicMessages(convo);
  assert(anM.length === 3 && Array.isArray(anM[1]!.content), "toAnthropicMessages שומר על מבנה ה-blocks");
  const oaM = toOpenAiMessages("SYS", convo);
  assert(oaM[0]!.role === "system", "toOpenAiMessages: system ראשון");
  const asst = oaM.find((m) => m.role === "assistant") as { tool_calls?: unknown[] } | undefined;
  assert(!!asst?.tool_calls && asst.tool_calls.length === 1, "toOpenAiMessages: tool_use → tool_calls");
  const toolMsg = oaM.find((m) => m.role === "tool") as { tool_call_id?: string } | undefined;
  assert(toolMsg?.tool_call_id === "c1", "toOpenAiMessages: tool_result → role:tool עם tool_call_id");

  // תרגום תגובה
  const anResp = fromAnthropicResponse({
    content: [
      { type: "text", text: "היי" },
      { type: "tool_use", id: "u1", name: "t1", input: { a: 1 } },
    ],
    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 },
  } as never);
  assert(anResp.text === "היי" && anResp.toolCalls[0]!.name === "t1" && anResp.usage.cachedInputTokens === 4, "fromAnthropicResponse: text + toolCalls + cached");

  const oaResp = fromOpenAiResponse({
    choices: [
      {
        message: {
          content: "שלום",
          tool_calls: [{ id: "o1", type: "function", function: { name: "t1", arguments: '{"a":2}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } },
  } as never);
  assert(
    oaResp.text === "שלום" &&
      oaResp.toolCalls[0]!.name === "t1" &&
      (oaResp.toolCalls[0]!.input as { a: number }).a === 2 &&
      oaResp.usage.inputTokens === 20 &&
      oaResp.usage.cachedInputTokens === 5,
    "fromOpenAiResponse: text + toolCalls (arguments מפורסר) + usage",
  );
  const oaBad = fromOpenAiResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: "o2", type: "function", function: { name: "t1", arguments: "{bad" } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  } as never);
  assert(JSON.stringify(oaBad.toolCalls[0]!.input) === "{}", "fromOpenAiResponse: arguments לא תקין → {} (לא קורס)");

  // ═══ ניתוב + הרצה בין ספקים (1–6, 11, 12) ═══
  logger.info("— ניתוב והרצה —");

  // 1. FAST Anthropic
  {
    const r = await runScenario({ fast: AN_FAST, smart: AN_SMART, message: SIMPLE, scripts: { [AN_FAST.model]: [{ text: "בוצע" }] } });
    assert(
      r.routed.tier === "fast" && r.routed.provider === "anthropic" && r.routed.outcome.text === "בוצע" && !r.routed.fallbackUsed && r.modelCalls.length === 1,
      "1. FAST Anthropic — קריאה אחת, provider anthropic",
    );
  }
  // 2. SMART Anthropic
  {
    const r = await runScenario({ fast: AN_FAST, smart: AN_SMART, message: COMPLEX, scripts: { [AN_SMART.model]: [{ text: "ניתוח" }] } });
    assert(r.routed.tier === "smart" && r.routed.provider === "anthropic" && r.modelCalls[0]!.model === AN_SMART.model, "2. SMART Anthropic — נותב ל-smart");
  }
  // 3. FAST OpenAI
  {
    const r = await runScenario({ fast: OAI_FAST, smart: AN_SMART, message: SIMPLE, scripts: { [OAI_FAST.model]: [{ text: "ok" }] } });
    assert(r.routed.tier === "fast" && r.routed.provider === "openai" && r.routed.model === "gpt-5.4-mini", "3. FAST OpenAI (gpt-5.4-mini)");
  }
  // 4. SMART OpenAI
  {
    const r = await runScenario({ fast: AN_FAST, smart: OAI_SMART, message: COMPLEX, scripts: { [OAI_SMART.model]: [{ text: "analysis" }] } });
    assert(r.routed.tier === "smart" && r.routed.provider === "openai" && r.routed.model === "gpt-5", "4. SMART OpenAI (gpt-5)");
  }
  // 5. FAST OpenAI → fallback SMART Anthropic
  {
    const r = await runScenario({
      fast: OAI_FAST,
      smart: AN_SMART,
      message: SIMPLE,
      scripts: { [OAI_FAST.model]: [{ error: true }], [AN_SMART.model]: [{ text: "סונטה הצילה" }] },
    });
    assert(
      r.routed.fallbackUsed && r.routed.provider === "anthropic" && r.routed.model === "claude-sonnet-5" && r.routed.outcome.text === "סונטה הצילה",
      "5. FAST OpenAI נכשל → fallback ל-SMART Anthropic",
    );
    assert(
      r.modelCalls.length === 2 && r.modelCalls[0]!.provider === "openai" && r.modelCalls[1]!.provider === "anthropic",
      "5. בדיוק 2 קריאות: openai ואז anthropic",
    );
  }
  // 6. FAST Anthropic → fallback SMART OpenAI
  {
    const r = await runScenario({
      fast: AN_FAST,
      smart: OAI_SMART,
      message: SIMPLE,
      scripts: { [AN_FAST.model]: [{ error: true }], [OAI_SMART.model]: [{ text: "gpt הציל" }] },
    });
    assert(
      r.routed.fallbackUsed && r.routed.provider === "openai" && r.routed.outcome.text === "gpt הציל",
      "6. FAST Anthropic נכשל → fallback ל-SMART OpenAI",
    );
  }
  // 11a. tool call דרך provider — הרצה אחת לכל קריאה, בלי כפילות
  {
    const r = await runScenario({
      fast: AN_FAST,
      smart: AN_SMART,
      message: SIMPLE,
      toolSideEffect: false,
      scripts: { [AN_FAST.model]: [{ toolCalls: [{ name: "do_thing" }] }, { toolCalls: [{ name: "do_thing" }] }, { text: "סוף" }] },
    });
    assert(r.execCount() === 2 && r.routed.outcome.text === "סוף" && !r.routed.fallbackUsed, "11. שתי קריאות כלי → הורצו פעמיים בדיוק (בלי כפילות, בלי לולאה)");
    assert(r.modelCalls.length === 3, "11. 3 סבבי מודל (כלי, כלי, טקסט) — הלולאה לא רצה מחדש על עצמה");
  }
  // 11b. FAST הריץ כלי עם תופעת לוואי ואז נכשל → אין fallback (לא מכפילים פעולה)
  {
    const r = await runScenario({
      fast: AN_FAST,
      smart: AN_SMART,
      message: SIMPLE,
      toolSideEffect: true,
      scripts: { [AN_FAST.model]: [{ toolCalls: [{ name: "do_thing" }] }, { error: true }], [AN_SMART.model]: [{ text: "לא אמור לרוץ" }] },
    });
    assert(!r.routed.fallbackUsed && r.execCount() === 1, "11. כלי עם תופעת לוואי רץ ואז שגיאה → בלי fallback, הכלי רץ פעם אחת בלבד");
    assert(!r.modelCalls.some((c) => c.model === AN_SMART.model), "11. SMART לא נקרא אחרי תופעת לוואי");
  }
  // 12. אין קריאת AI כפולה כשלא צריך — FAST הצליח
  {
    const r = await runScenario({ fast: AN_FAST, smart: OAI_SMART, message: SIMPLE, scripts: { [AN_FAST.model]: [{ text: "מיד" }] } });
    assert(r.modelCalls.length === 1 && !r.routed.fallbackUsed && !r.modelCalls.some((c) => c.provider === "openai"), "12. FAST הצליח → קריאת AI אחת בלבד, SMART לא נקרא");
  }

  logger.info("");
  if (failures > 0) {
    logger.error(`${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("כל בדיקות ה-providers עברו ✅");
}

main().catch((err) => {
  logger.error(err, "test-ai-providers failed");
  process.exit(1);
});
