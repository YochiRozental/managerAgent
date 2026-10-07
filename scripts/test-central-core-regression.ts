/**
 * Step 3F.7B (2026-10-07) — deterministic regression proof for the Central Agent Core
 * (src/ai/routedAgent.ts + src/ai/agentLoop.ts) as consumed by Web (ops/chat.ts) and WhatsApp
 * (integrations/claude/orchestrator.ts).
 *
 * Written in two passes against this session's actual history, both still present below:
 *  1. A baseline captured BEFORE the 3F.7B extraction, reimplementing (inline, copied verbatim)
 *     the exact history/tool-normalization expressions chat.ts and orchestrator.ts had before
 *     this step, run through runRoutedAgent — this is "today's real behavior," asserted first.
 *  2. A "Phase 2 parity" section (bottom of this file), added once src/ai/normalize.ts and the
 *     runCentralAgent alias (src/ai/routedAgent.ts) existed, proving: (a) toNormMessages/
 *     toNormTools produce byte-identical output to the old inline expressions for the same
 *     inputs, and (b) runCentralAgent is the exact same function reference as runRoutedAgent —
 *     not a second implementation.
 *
 * The 3F.7A audit (HEAD b4e1063) found that runRoutedAgent+agentLoop already ARE the shared
 * Central Agent Core — this file is the deterministic proof that both channels' current
 * buildLoop/executeToolCall shapes behave through that Core exactly as they do in production,
 * across the 12 properties the audit flagged as the ones an extraction could accidentally change:
 * normalized history, model-facing tool list, system prompt, maxTurns (7 vs 8), screenToolCalls
 * presence, finalizeText behavior, tool-result serialization, model-call count/order,
 * sideEffectCount semantics (Web override vs WhatsApp default), confirmation halting,
 * channel-specific denial/error text, and buildLoop being re-created (not memoized) per attempt.
 *
 * No live model calls — everything goes through the existing _runModel/_config test seams that
 * routedAgent.ts/agentLoop.ts already support.
 *
 *   npm run test:central-core-regression
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runRoutedAgent, runCentralAgent } from "../src/ai/routedAgent.js";
import type { RunModelFn } from "../src/ai/agentLoop.js";
import type { NormMessage, NormToolCall, RunModelParams, RunModelResult } from "../src/ai/providers/types.js";
import { dispatchToolDefinition } from "../src/ai/dispatcher.js";
import type { ToolDefinition } from "../src/ai/toolRegistry.js";
import { toNormMessages, toNormTools } from "../src/ai/normalize.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) logger.info(`✅ ${msg}`);
  else {
    failures++;
    logger.error(`❌ ${msg}`);
  }
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSrc(relPath: string): string {
  return readFileSync(join(__dirname, "..", "src", ...relPath.split("/")), "utf-8");
}

const FAST = { provider: "anthropic" as const, model: "test-fast" };
const SMART = { provider: "anthropic" as const, model: "test-smart" };
const TEST_CONFIG = { fast: FAST, smart: SMART, costLogging: false };

/** Scripts a sequence of RunModelResult-shaped steps per model name; records every call's full params. */
type ScriptStep = { text?: string; toolCalls?: { name: string; input?: unknown }[] };
function makeScriptedRunModel(scriptByModel: Record<string, ScriptStep[]>) {
  const calls: RunModelParams[] = [];
  const cursor: Record<string, number> = {};
  const fn: RunModelFn = async (params) => {
    calls.push(params);
    const script = scriptByModel[params.model] ?? [{ text: "x" }];
    const i = cursor[params.model] ?? 0;
    cursor[params.model] = i + 1;
    const step = script[Math.min(i, script.length - 1)]!;
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
    if (step.toolCalls) {
      const tcs: NormToolCall[] = step.toolCalls.map((t, k) => ({ id: `tc_${i}_${k}`, name: t.name, input: t.input ?? {} }));
      return { text: "", toolCalls: tcs, assistantContent: tcs.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input })), usage };
    }
    const text = step.text ?? "";
    return { text, toolCalls: [], assistantContent: [{ type: "text" as const, text }], usage };
  };
  return { fn, calls };
}

// Shapes mirroring today's two real channel-local types (ops/chat.ts's ChatMessage,
// orchestrator.ts's ConversationMessage) — structurally identical, as in production.
interface ChannelMessageLike {
  role: "user" | "assistant";
  content: string;
}
interface WebToolLike {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
interface WhatsappToolLike {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/** Today's inline expression in ops/chat.ts and orchestrator.ts's buildLoop — copied verbatim (both identical). */
function inlineToNormMessages(history: ChannelMessageLike[]): NormMessage[] {
  return history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}
/** Today's inline expression in ops/chat.ts, computed once outside buildLoop. */
function webInlineToNormTools(tools: WebToolLike[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
}
/** Today's inline expression in orchestrator.ts, computed once outside buildLoop (after toAnthropicTools). */
function whatsappInlineToNormTools(tools: WhatsappToolLike[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: (t.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));
}

async function main() {
  // ───────────────────────── 4. maxTurns: Web=7, WhatsApp=8 — cross-checked against real source ─────────────────────────
  logger.info("— maxTurns: 7 (Web) / 8 (WhatsApp), ושניהם תואמים את המקור בפועל —");
  const chatSrc = readSrc("ops/chat.ts");
  const orchestratorSrc = readSrc("integrations/claude/orchestrator.ts");
  assert(/const MAX_TURNS = 7;/.test(chatSrc), "ops/chat.ts: MAX_TURNS === 7 במקור בפועל");
  assert(/const MAX_TOOL_TURNS = 8;/.test(orchestratorSrc), "orchestrator.ts: MAX_TOOL_TURNS === 8 במקור בפועל");
  const WEB_MAX_TURNS: number = 7;
  const WHATSAPP_MAX_TURNS: number = 8;
  assert(WEB_MAX_TURNS !== WHATSAPP_MAX_TURNS, "שני הערוצים משתמשים בערכי maxTurns שונים בכוונה — אסור לאחד אותם");

  // ───────────────────────── 1+2. normalized history + tool list — baseline (today's inline logic) ─────────────────────────
  logger.info("— היסטוריה/כלים מנורמלים: הלוגיקה הנוכחית (inline), לפני כל extraction —");
  const sampleHistory: ChannelMessageLike[] = [
    { role: "user", content: "שלום" },
    { role: "assistant", content: "היי" },
    { role: "user", content: "מה המשימות שלי" },
  ];
  const normMessages = inlineToNormMessages(sampleHistory);
  assert(
    deepEqual(normMessages, [
      { role: "user", content: "שלום" },
      { role: "assistant", content: "היי" },
      { role: "user", content: "מה המשימות שלי" },
    ]),
    "inlineToNormMessages: ממפה role/content כפי שהם, בלי שינוי",
  );

  const webTools: WebToolLike[] = [{ name: "do_thing", description: "עושה דבר", input_schema: { type: "object", properties: { x: { type: "string" } } } }];
  const webNormTools = webInlineToNormTools(webTools);
  assert(
    deepEqual(webNormTools, [{ name: "do_thing", description: "עושה דבר", parameters: { type: "object", properties: { x: { type: "string" } } } }]),
    "Web: tools → NormTool (name/description/parameters=input_schema), ללא שינוי",
  );

  const whatsappTools: WhatsappToolLike[] = [{ name: "do_thing", description: "עושה דבר", input_schema: { type: "object", properties: { x: { type: "string" } } } }];
  const whatsappNormTools = whatsappInlineToNormTools(whatsappTools);
  assert(deepEqual(whatsappNormTools, webNormTools), "WhatsApp (עם description/input_schema מלאים): אותה תוצאה בדיוק כמו Web");
  const whatsappToolsMissingFields: WhatsappToolLike[] = [{ name: "bare_tool" }];
  const whatsappNormToolsDefaulted = whatsappInlineToNormTools(whatsappToolsMissingFields);
  assert(
    deepEqual(whatsappNormToolsDefaulted, [{ name: "bare_tool", description: "", parameters: { type: "object", properties: {} } }]),
    "WhatsApp: description/input_schema חסרים → default ('' / {type:object,properties:{}}) — ללא קריסה",
  );

  // ───────────────────────── 3. system prompt מועבר כפי שהוא ─────────────────────────
  logger.info("— system prompt מועבר ל-_runModel כפי שהוא, בלי שינוי —");
  {
    const { fn, calls } = makeScriptedRunModel({ "test-fast": [{ text: "תשובה" }] });
    await runCentralAgent({
      useCase: "ops_chat",
      latestMessage: "שלום",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn,
      buildLoop: () => ({
        system: "SYSTEM-PROMPT-MARKER-12345",
        maxTokens: 100,
        maxTurns: WEB_MAX_TURNS,
        messages: inlineToNormMessages(sampleHistory),
        tools: webNormTools,
        executeToolCall: async () => ({ content: "{}", sideEffect: false }),
      }),
    });
    assert(calls.length === 1 && calls[0]!.system === "SYSTEM-PROMPT-MARKER-12345", "system prompt המדויק מגיע ל-_runModel");
  }

  // ───────────────────────── 5. screenToolCalls — נעדר ב-Web, קיים ב-WhatsApp ─────────────────────────
  logger.info("— screenToolCalls: Web לא מספק אותו בכלל, WhatsApp כן — ההבדל נשמר —");
  {
    // Web-shaped: אין screenToolCalls כלל — כלי עם requiresConfirmation=true (תיאורטי) עדיין רץ.
    let webExecuted = 0;
    const { fn } = makeScriptedRunModel({
      "test-fast": [{ toolCalls: [{ name: "delete_thing" }] }, { text: "בוצע" }],
    });
    const webSpec = () => ({
      system: "s",
      maxTokens: 100,
      maxTurns: WEB_MAX_TURNS,
      messages: [] as NormMessage[],
      tools: [{ name: "delete_thing", description: "x", parameters: { type: "object", properties: {} } }],
      executeToolCall: async () => {
        webExecuted += 1;
        return { content: "{}", sideEffect: true };
      },
      // no screenToolCalls key at all — exactly like ops/chat.ts's buildLoop
    });
    assert(!("screenToolCalls" in webSpec()), "Web-shaped buildLoop: אין מפתח screenToolCalls בכלל באובייקט המוחזר");
    const webResult = await runCentralAgent({
      useCase: "ops_chat",
      latestMessage: "מחק",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn,
      buildLoop: webSpec,
    });
    assert(webExecuted === 1 && webResult.outcome.halted === null, "Web: בלי screenToolCalls, הכלי רץ ישר — אין halt");

    // WhatsApp-shaped: יש screenToolCalls שבודק requiresConfirmation ועוצר.
    const { fn: fn2 } = makeScriptedRunModel({ "test-fast": [{ toolCalls: [{ name: "delete_thing" }] }] });
    let waExecuted = 0;
    const waResult = await runCentralAgent({
      useCase: "whatsapp_orchestrator",
      latestMessage: "מחק",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn2,
      buildLoop: () => ({
        system: "s",
        maxTokens: 100,
        maxTurns: WHATSAPP_MAX_TURNS,
        messages: [] as NormMessage[],
        tools: [{ name: "delete_thing", description: "x", parameters: { type: "object", properties: {} } }],
        screenToolCalls: (calls: NormToolCall[]) =>
          calls.find((c) => c.name === "delete_thing") ? { reason: "confirm", payload: { toolName: "delete_thing", input: {} } } : null,
        executeToolCall: async () => {
          waExecuted += 1;
          return { content: "{}", sideEffect: true };
        },
      }),
    });
    assert(waExecuted === 0, "WhatsApp: screenToolCalls עוצר לפני שהכלי רץ בכלל");
    assert(waResult.outcome.halted?.reason === "confirm", "WhatsApp: outcome.halted.reason === 'confirm'");
  }

  // ───────────────────────── 6. finalizeText — Web overrides, WhatsApp doesn't ─────────────────────────
  logger.info("— finalizeText: Web יכול לדרוס את טקסט המודל, WhatsApp מחזיר את טקסט המודל כפי שהוא —");
  {
    const { fn } = makeScriptedRunModel({ "test-fast": [{ text: "הניסוח החופשי של המודל" }] });
    const webResult = await runCentralAgent({
      useCase: "ops_chat",
      latestMessage: "בוקר טוב",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn,
      buildLoop: () => ({
        system: "s",
        maxTokens: 100,
        maxTurns: WEB_MAX_TURNS,
        messages: [] as NormMessage[],
        tools: [],
        executeToolCall: async () => ({ content: "{}", sideEffect: false }),
        finalizeText: (_modelText: string) => "תדריך-הבוקר-המקובע",
      }),
    });
    assert(webResult.outcome.text === "תדריך-הבוקר-המקובע", "Web: finalizeText דורס את טקסט המודל");

    const { fn: fn2 } = makeScriptedRunModel({ "test-fast": [{ text: "הניסוח החופשי של המודל" }] });
    const waResult = await runCentralAgent({
      useCase: "whatsapp_orchestrator",
      latestMessage: "בוקר טוב",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn2,
      buildLoop: () => ({
        system: "s",
        maxTokens: 100,
        maxTurns: WHATSAPP_MAX_TURNS,
        messages: [] as NormMessage[],
        tools: [],
        executeToolCall: async () => ({ content: "{}", sideEffect: false }),
        // no finalizeText — exactly like orchestrator.ts's buildLoop
      }),
    });
    assert(waResult.outcome.text === "הניסוח החופשי של המודל", "WhatsApp: בלי finalizeText, טקסט המודל מוחזר כפי שהוא");
  }

  // ───────────────────────── 7+8. tool-result serialization + מספר/סדר קריאות המודל ─────────────────────────
  logger.info("— tool-result serialization מדויק, ומספר/סדר קריאות ה-_runModel —");
  {
    const { fn, calls } = makeScriptedRunModel({
      "test-fast": [{ toolCalls: [{ name: "get_thing", input: { id: "1" } }] }, { text: "סופי" }],
    });
    const result = await runCentralAgent({
      useCase: "ops_chat",
      latestMessage: "x",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn,
      buildLoop: () => ({
        system: "s",
        maxTokens: 100,
        maxTurns: WEB_MAX_TURNS,
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "get_thing", description: "x", parameters: { type: "object", properties: {} } }],
        executeToolCall: async () => ({ content: JSON.stringify({ ok: true, value: 42 }), sideEffect: true }),
      }),
    });
    assert(calls.length === 2, `_runModel נקרא פעמיים בדיוק (בפועל ${calls.length})`);
    assert(result.outcome.text === "סופי", "הטקסט הסופי מגיע מהקריאה השנייה");
    const secondCallMessages = calls[1]!.messages;
    const last = secondCallMessages[secondCallMessages.length - 1]!;
    assert(last.role === "user", "ההודעה האחרונה שנשלחת בקריאה השנייה היא role=user (tool_result)");
    assert(
      Array.isArray(last.content) && last.content[0]?.type === "tool_result" && (last.content[0] as { content: string }).content === '{"ok":true,"value":42}',
      "תוכן ה-tool_result הוא JSON.stringify המדויק של תוצאת executeToolCall",
    );
    const assistantMsg = secondCallMessages[secondCallMessages.length - 2]!;
    assert(assistantMsg.role === "assistant", "לפני ה-tool_result נמצאת הודעת assistant (tool_use) — סדר נכון");
  }

  // ───────────────────────── 9. sideEffectCount: Web override vs WhatsApp default ─────────────────────────
  logger.info("— sideEffectCount: Web (actions.length חיצוני) שונה במכוון מ-WhatsApp (outcome.sideEffects) —");
  {
    // תרחיש: FAST מריץ כלי אחד (dispatcher-style sideEffect:true), ואז מחזיר טקסט ריק (failed=emptyText).
    const webActions: string[] = []; // הכלי "הצליח" אבל לא דחף שום דבר ל-actions — מדמה כלי קריאה.
    const { fn } = makeScriptedRunModel({
      "test-fast": [{ toolCalls: [{ name: "read_thing" }] }, { text: "" }],
      "test-smart": [{ text: "תשובה מ-SMART" }],
    });
    const webResult = await runCentralAgent({
      useCase: "ops_chat",
      latestMessage: "x",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn,
      sideEffectCount: () => webActions.length, // ==Web's override
      buildLoop: () => ({
        system: "s",
        maxTokens: 100,
        maxTurns: WEB_MAX_TURNS,
        messages: [] as NormMessage[],
        tools: [{ name: "read_thing", description: "x", parameters: { type: "object", properties: {} } }],
        executeToolCall: async () => ({ content: "{}", sideEffect: true }), // מצליח, אבל לא דוחף ל-webActions
      }),
    });
    assert(webResult.fallbackUsed === true, "Web: actions.length===0 (אף שה-dispatcher החזיר sideEffect:true) ⇒ מסלים ל-SMART");
    assert(webResult.outcome.text === "תשובה מ-SMART", "Web: אחרי ההסלמה, התשובה מגיעה מ-SMART");

    const { fn: fn2 } = makeScriptedRunModel({
      "test-fast": [{ toolCalls: [{ name: "read_thing" }] }, { text: "" }],
      "test-smart": [{ text: "לא אמור להגיע לכאן" }],
    });
    const waResult = await runCentralAgent({
      useCase: "whatsapp_orchestrator",
      latestMessage: "x",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn2,
      // no sideEffectCount override — default = outcome.sideEffects
      buildLoop: () => ({
        system: "s",
        maxTokens: 100,
        maxTurns: WHATSAPP_MAX_TURNS,
        messages: [] as NormMessage[],
        tools: [{ name: "read_thing", description: "x", parameters: { type: "object", properties: {} } }],
        executeToolCall: async () => ({ content: "{}", sideEffect: true }),
      }),
    });
    assert(
      waResult.fallbackUsed === false,
      "WhatsApp: outcome.sideEffects===1 (אותו תרחיש בדיוק) ⇒ לא מסלים — ברירת המחדל שונה במכוון מ-Web",
    );
  }

  // ───────────────────────── 10. halted confirmation — שום tool_result לא נשלח, _runModel נקרא פעם אחת ─────────────────────────
  logger.info("— halted confirmation: executeToolCall לא רץ, _runModel נקרא פעם אחת בדיוק —");
  {
    const { fn, calls } = makeScriptedRunModel({ "test-fast": [{ toolCalls: [{ name: "delete_thing" }] }] });
    let executed = 0;
    const result = await runCentralAgent({
      useCase: "whatsapp_orchestrator",
      latestMessage: "מחק",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn,
      buildLoop: () => ({
        system: "s",
        maxTokens: 100,
        maxTurns: WHATSAPP_MAX_TURNS,
        messages: [] as NormMessage[],
        tools: [{ name: "delete_thing", description: "x", parameters: { type: "object", properties: {} } }],
        screenToolCalls: () => ({ reason: "confirm", payload: { toolName: "delete_thing", input: {} } }),
        executeToolCall: async () => {
          executed += 1;
          return { content: "{}", sideEffect: true };
        },
      }),
    });
    assert(executed === 0, "executeToolCall לא נקרא כש-screenToolCalls עוצר");
    assert(calls.length === 1, "_runModel נקרא פעם אחת בדיוק — אין קריאה שנייה אחרי halt");
    assert(deepEqual(result.outcome.halted?.payload, { toolName: "delete_thing", input: {} }), "ה-payload של ה-halt מדויק");
  }

  // ───────────────────────── 11. denial/error text נשאר channel-specific (מאומת מול המקור) ─────────────────────────
  logger.info("— denial/error text: שונה בין הערוצים, מאומת גם דרך dispatchToolDefinition וגם מול המקור —");
  {
    const fakeTool: ToolDefinition = {
      name: "fake_tool",
      description: "x",
      input_schema: { type: "object", properties: {} },
      requiresConfirmation: false,
      requiredPermission: "finance:manage",
      execute: async () => ({ ok: true }),
    };
    const webDenial = await dispatchToolDefinition(fakeTool, {}, { user: null });
    assert(webDenial.content === "שגיאה: אין הרשאה להשתמש בכלי fake_tool.", "ברירת המחדל (Web לא מצהיר formatDenied): הטקסט של Web");
    const waDenial = await dispatchToolDefinition(fakeTool, {}, { user: null }, {
      formatDenied: () => `שגיאה: למשתמש אין הרשאה להשתמש בכלי fake_tool.`,
    });
    assert(waDenial.content === "שגיאה: למשתמש אין הרשאה להשתמש בכלי fake_tool.", "formatDenied של WhatsApp: טקסט שונה במכוון מ-Web");
    assert(webDenial.content !== waDenial.content, "שני הטקסטים שונים — אין איחוד בטעות");

    assert(orchestratorSrc.includes("שגיאה: למשתמש אין הרשאה להשתמש בכלי"), "orchestrator.ts: הטקסט הזה עדיין קיים במקור בפועל");
    assert(!chatSrc.includes("למשתמש אין הרשאה"), "chat.ts: לא אימץ את נוסח ה-WhatsApp");
    assert(orchestratorSrc.includes("כלי ${call.name} נכשל"), "orchestrator.ts: לוג שגיאת-הרצה עדיין בנוסח הייחודי שלו");
  }

  // ───────────────────────── 12. buildLoop נוצר מחדש בכל ניסיון, לא memoized ─────────────────────────
  // הסיכון האמיתי: ש-runRoutedAgent יקרא ל-buildLoop() פעם אחת ויריץ FAST→SMART על ה-LoopSpec
  // *הישן*, בלי לתת ל-Web's buildLoop הזדמנות לאפס מצב מוטבעtב (כמו capturedBriefing) לפני SMART.
  // ההוכחה: מספר הקריאות ל-buildLoop (2) + שה-system שנשלח בפועל ל-_runModel בכל ניסיון הוא
  // ה-marker הטרי שנבנה *באותה קריאה* ל-buildLoop, לא עותק מהניסיון הקודם.
  logger.info("— buildLoop נקרא מחדש בכל ניסיון (FAST, ואז SMART) ומחזיר תוכן טרי, לא memoized —");
  {
    let buildLoopCalls = 0;
    const { fn, calls } = makeScriptedRunModel({
      "test-fast": [{ text: "" }], // ריק ⇒ failed=emptyText ⇒ (עם sideEffectCount=0) מסלים
      "test-smart": [{ text: "תשובת SMART" }],
    });
    await runCentralAgent({
      useCase: "ops_chat",
      latestMessage: "x",
      historyLength: 1,
      canSeeAllWork: false,
      forceTier: "fast",
      _config: TEST_CONFIG,
      _runModel: fn,
      sideEffectCount: () => 0,
      buildLoop: () => {
        buildLoopCalls += 1;
        return {
          system: `attempt-marker-${buildLoopCalls}`, // מדמה תוכן/מצב שנבנה טרי בכל קריאה
          maxTokens: 100,
          maxTurns: WEB_MAX_TURNS,
          messages: [] as NormMessage[],
          tools: [],
          executeToolCall: async () => ({ content: "{}", sideEffect: false }),
        };
      },
    });
    assert(buildLoopCalls === 2, `buildLoop נקרא פעמיים (אחת לכל tier) — בפועל ${buildLoopCalls}`);
    assert(calls.length === 2, "שתי קריאות ל-_runModel בפועל (אחת לכל tier)");
    assert(
      calls[0]!.system === "attempt-marker-1" && calls[1]!.system === "attempt-marker-2",
      "כל קריאת _runModel קיבלה את ה-system הטרי מה-buildLoop-call התואם לה — אין שימוש חוזר ב-LoopSpec של ניסיון קודם",
    );
  }

  // ═══════════════════════════ Phase 2 parity: src/ai/normalize.ts matches the old inline logic byte-for-byte ═══════════════════════════
  // נוסף אחרי החילוץ (3F.7B Phase 2): מוכיח ש-toNormMessages/toNormTools (src/ai/normalize.ts),
  // שהם מה ש-ops/chat.ts ו-orchestrator.ts קוראים להם עכשיו בפועל, מחזירים תוצאה זהה בדיוק
  // לביטויי ה-inline הישנים (המוגדרים למעלה) על אותם קלטים — לא רק "דומה", זהה. וגם שה-core
  // call site (runCentralAgent) הוא לא implementation שני — אותו reference בדיוק כמו runRoutedAgent.
  logger.info("— Phase 2 parity: toNormMessages/toNormTools === הלוגיקה הישנה, byte-for-byte —");
  assert(
    deepEqual(toNormMessages(sampleHistory), inlineToNormMessages(sampleHistory)),
    "toNormMessages(history) === הביטוי הישן history.map(...) — לאותו input, אותו output",
  );
  assert(
    deepEqual(toNormTools(webTools), webInlineToNormTools(webTools)),
    "toNormTools(Web tools) === הביטוי הישן של Web (name/description/parameters=input_schema)",
  );
  assert(
    deepEqual(toNormTools(whatsappTools), whatsappInlineToNormTools(whatsappTools)),
    "toNormTools(WhatsApp tools, שדות מלאים) === הביטוי הישן של WhatsApp",
  );
  assert(
    deepEqual(toNormTools(whatsappToolsMissingFields), whatsappInlineToNormTools(whatsappToolsMissingFields)),
    "toNormTools(WhatsApp tools, שדות חסרים) === הביטוי הישן של WhatsApp — כולל ה-defaults",
  );
  assert(runCentralAgent === runRoutedAgent, "runCentralAgent הוא בדיוק אותו function reference כמו runRoutedAgent — alias, לא implementation שני");

  logger.info("— Phase 2 parity: chat.ts/orchestrator.ts בפועל קוראים ל-toNormMessages/toNormTools/runCentralAgent —");
  const chatSrcAfter = readFileSync(join(__dirname, "..", "src", "ops", "chat.ts"), "utf-8");
  const orchestratorSrcAfter = readFileSync(join(__dirname, "..", "src", "integrations", "claude", "orchestrator.ts"), "utf-8");
  assert(chatSrcAfter.includes('from "../ai/normalize.js"') && chatSrcAfter.includes("toNormMessages(history)"), "ops/chat.ts: קורא בפועל ל-toNormMessages/toNormTools");
  assert(chatSrcAfter.includes("runCentralAgent({"), "ops/chat.ts: קורא בפועל ל-runCentralAgent (לא runRoutedAgent)");
  assert(
    orchestratorSrcAfter.includes('from "../../ai/normalize.js"') && orchestratorSrcAfter.includes("toNormMessages(history)"),
    "orchestrator.ts: קורא בפועל ל-toNormMessages/toNormTools",
  );
  assert(orchestratorSrcAfter.includes("runCentralAgent({"), "orchestrator.ts: קורא בפועל ל-runCentralAgent (לא runRoutedAgent)");
  assert(
    !chatSrcAfter.includes('history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))'),
    "ops/chat.ts: הביטוי ה-inline הישן לנרמול היסטוריה הוסר — לא עוד כפילות",
  );
  assert(
    !orchestratorSrcAfter.includes('history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))'),
    "orchestrator.ts: הביטוי ה-inline הישן לנרמול היסטוריה הוסר — לא עוד כפילות",
  );

  if (failures > 0) {
    logger.error(`\n${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-central-core-regression עברו ✅");
}

main().catch((err) => {
  logger.error(err, "כשל לא צפוי בהרצת הבדיקות");
  process.exit(1);
});
