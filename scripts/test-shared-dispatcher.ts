/**
 * Central Agent Core unification (2026-10-07) — direct, non-live tests of
 * src/ai/dispatcher.ts's dispatchToolDefinition, the ONE shared ToolDefinition execution
 * dispatcher that Web (ops/chat.ts) and WhatsApp (integrations/claude/orchestrator.ts,
 * pipeline/messageHandler.ts's confirmed-execution resolution) now all call, built directly on
 * top of the read-only dispatcher audit done at HEAD 8e8a14f.
 *
 * Unlike the pre-unification tests (test-web-shared-tool-definition.ts), which had to read
 * runOpsChat's executeToolCall closure from source text because it wasn't independently
 * invokable, dispatchToolDefinition itself now IS a standalone function — these tests call it
 * directly with fake ToolDefinitions, no source-regex archaeology, no live Monday/AI/WhatsApp.
 *
 * Proves (mapped to the migration's own §8 requirements):
 *  1. Web and WhatsApp (+ WhatsApp's confirmed-execution path) all actually import and call
 *     dispatchToolDefinition — source-level check on the three call sites.
 *  2/3. enforceExecutionTimePermission defaults to true (undefined ⇒ enforce) and actually
 *     gates/bypasses isToolAllowedForUser when set — proven against a fake tool, not just read.
 *  4. No real tool in production (Web's 9 AgentTool-backed ToolDefinitions, WhatsApp's 20) opts
 *     out (enforceExecutionTimePermission !== false anywhere) — the migration changed no tool's
 *     actual enforcement.
 *  10/12/13/14. Hook ordering (onBeforeExecute → execute → onExecuted; denial/error never reach
 *     onExecuted), execute() called exactly once per dispatch (no double execution), default and
 *     overridden error/denial text shapes, and that permission denial can never be bypassed by a
 *     tool that throws from inside execute (it's checked and rejected *before* execute runs).
 *  5 (migration §5). Characterizes, before any swap, that WhatsApp's OLD confirmed-execution
 *     permission check (messageHandler.ts, pre-migration: `tool.requiredPermission &&
 *     !user.permissions.includes(...)`) is behaviorally IDENTICAL to isToolAllowedForUser for
 *     every currently real `requiresConfirmation: true` WhatsApp tool, across all 5 roles — proof
 *     that routing confirmed execution through the shared dispatcher changes nothing today.
 *
 *   npm run test:shared-dispatcher
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dispatchToolDefinition } from "../src/ai/dispatcher.js";
import { isToolAllowedForUser, type ToolContext, type ToolDefinition } from "../src/ai/toolRegistry.js";
import { tools as whatsappTools } from "../src/integrations/claude/tools.js";
import {
  MARK_DONE_TOOL_DEFINITION,
  SET_STATUS_TOOL_DEFINITION,
  ADD_NOTE_TOOL_DEFINITION,
  REPORT_BLOCKER_TOOL_DEFINITION,
  ADD_UPDATE_TOOL_DEFINITION,
  CREATE_TASK_TOOL_DEFINITION,
  CREATE_LEAD_TOOL_DEFINITION,
  CREATE_PROJECT_STAGE_TOOL_DEFINITION,
  REASSIGN_ITEM_TOOL_DEFINITION,
} from "../src/ops/chat.js";
import { resolveUserByKey, type IdentifiedUser } from "../src/identity/index.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) logger.info(`✅ ${msg}`);
  else {
    failures++;
    logger.error(`❌ ${msg}`);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSrc(relPath: string): string {
  return readFileSync(join(__dirname, "..", "src", ...relPath.split("/")), "utf-8");
}

const moti = resolveUserByKey("moti")!; // owner
const dov = resolveUserByKey("dov")!; // project_manager
const ruchama = resolveUserByKey("ruchama")!; // planner
const goldi = resolveUserByKey("goldi")!; // finance — no task:update_own, no task:manage, no client:communicate
const yochi = resolveUserByKey("yochi")!; // admin

function fakeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: "fake",
    input_schema: { type: "object", properties: {} },
    requiresConfirmation: false,
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

async function main() {
  // ───────────────────────── 1. שלושת ה-call sites קוראים בפועל ל-dispatchToolDefinition ─────────────────────────
  logger.info("— שלושת ה-call sites (Web, WhatsApp, WhatsApp confirmed-execution) קוראים ל-dispatchToolDefinition —");
  const chatSrc = readSrc("ops/chat.ts");
  const orchestratorSrc = readSrc("integrations/claude/orchestrator.ts");
  const messageHandlerSrc = readSrc("pipeline/messageHandler.ts");
  assert(
    /from "\.\.\/ai\/dispatcher\.js"/.test(chatSrc) && chatSrc.includes("dispatchToolDefinition(tool, input, { user }"),
    "ops/chat.ts (Web): מייבא וקורא ל-dispatchToolDefinition",
  );
  assert(
    /from "\.\.\/\.\.\/ai\/dispatcher\.js"/.test(orchestratorSrc) && orchestratorSrc.includes("dispatchToolDefinition(tool, call.input, { user }"),
    "integrations/claude/orchestrator.ts (WhatsApp): מייבא וקורא ל-dispatchToolDefinition",
  );
  assert(
    /from "\.\.\/ai\/dispatcher\.js"/.test(messageHandlerSrc) &&
      messageHandlerSrc.includes("dispatchToolDefinition(tool, JSON.parse(pending.toolInput), { user }"),
    "pipeline/messageHandler.ts (WhatsApp confirmed-execution): מייבא וקורא ל-dispatchToolDefinition — לא עוד tool.execute ישיר",
  );

  // ───────────────────────── 2/3. enforceExecutionTimePermission: ברירת מחדל true, ונבדק בפועל ─────────────────────────
  logger.info("— enforceExecutionTimePermission: ברירת מחדל true (undefined⇒enforce), ונבדק מול isToolAllowedForUser בפועל —");
  {
    const tool = fakeTool({ name: "fake_enforced", requiredPermission: "finance:manage" });
    let executed = false;
    tool.execute = async () => {
      executed = true;
      return { ok: true };
    };
    const result = await dispatchToolDefinition(tool, {}, { user: ruchama }); // ruchama has no finance:manage
    assert(!executed, "enforceExecutionTimePermission לא מוגדר (undefined) ⇒ ברירת המחדל true חלה — נדחה, execute לא רץ");
    assert(result.sideEffect === false, "דחייה ⇒ sideEffect:false");
    assert(result.content === "שגיאה: אין הרשאה להשתמש בכלי fake_enforced.", "דחייה: טקסט ברירת המחדל זהה למה ש-Web הציג");
  }
  {
    const tool = fakeTool({ name: "fake_bypassed", requiredPermission: "finance:manage", enforceExecutionTimePermission: false });
    let executed = false;
    tool.execute = async () => {
      executed = true;
      return { ok: true };
    };
    const result = await dispatchToolDefinition(tool, {}, { user: ruchama }); // lacks finance:manage, but flag opts out
    assert(executed, "enforceExecutionTimePermission:false ⇒ isToolAllowedForUser לא נבדק בכלל — execute רץ גם בלי ההרשאה");
    assert(result.sideEffect === true, "execute הצליח ⇒ sideEffect:true");
  }
  assert(
    isToolAllowedForUser(fakeTool({ name: "x", requiredPermission: "finance:manage" }), ruchama) === false,
    "sanity: isToolAllowedForUser עצמו (לא הדיספצ'ר) כן דוחה את רוחמה על finance:manage — ה-bypass למעלה הוא בגלל הדגל, לא כי ה-permission check 'שקר'",
  );

  // ───────────────────────── 4. אף כלי production לא מקבל enforceExecutionTimePermission:false ─────────────────────────
  logger.info("— שום כלי קיים (Web's 9 AgentTool-backed, WhatsApp's 20) לא עבר ל-enforceExecutionTimePermission:false —");
  const webSharedTools: ToolDefinition[] = [
    MARK_DONE_TOOL_DEFINITION,
    SET_STATUS_TOOL_DEFINITION,
    ADD_NOTE_TOOL_DEFINITION,
    REPORT_BLOCKER_TOOL_DEFINITION,
    ADD_UPDATE_TOOL_DEFINITION,
    CREATE_TASK_TOOL_DEFINITION,
    CREATE_LEAD_TOOL_DEFINITION,
    CREATE_PROJECT_STAGE_TOOL_DEFINITION,
    REASSIGN_ITEM_TOOL_DEFINITION,
  ];
  for (const t of webSharedTools) {
    assert(t.enforceExecutionTimePermission !== false, `Web's ${t.name}: enforceExecutionTimePermission !== false (ברירת מחדל true חלה, כמו היום)`);
  }
  for (const t of whatsappTools) {
    assert(t.enforceExecutionTimePermission !== false, `WhatsApp's ${t.name}: enforceExecutionTimePermission !== false (ברירת מחדל true חלה, כמו היום)`);
  }

  // ───────────────────────── 10/13. סדר ה-hooks: onBeforeExecute → execute → onExecuted; execute פעם אחת בלבד ─────────────────────────
  logger.info("— סדר hooks: onBeforeExecute → tool.execute → onExecuted; execute נקרא פעם אחת בדיוק —");
  {
    const order: string[] = [];
    let executeCount = 0;
    const tool = fakeTool({
      name: "ordered",
      execute: async (input: Record<string, unknown>) => {
        executeCount++;
        order.push("execute");
        return { echoed: input };
      },
    });
    const result = await dispatchToolDefinition(tool, { a: 1 }, { user: moti }, {
      onBeforeExecute: () => order.push("before"),
      onExecuted: (_t, res) => {
        order.push("executed");
        assert((res as { echoed: unknown }).echoed !== undefined, "onExecuted מקבל את תוצאת tool.execute האמיתית");
      },
    });
    assert(executeCount === 1, "tool.execute נקרא פעם אחת בדיוק — אין double execution");
    assert(order.join(",") === "before,execute,executed", `סדר ה-hooks: before → execute → executed (בפועל: ${order.join(",")})`);
    assert(result.sideEffect === true, "הצלחה ⇒ sideEffect:true");
    assert(result.content === JSON.stringify({ echoed: { a: 1 } }), "content הוא JSON.stringify של תוצאת execute");
  }

  // ───────────────────────── 14. דחייה: onBeforeExecute/onExecuted לעולם לא נקראים, execute לעולם לא רץ ─────────────────────────
  logger.info("— דחיית הרשאה: execute/onBeforeExecute/onExecuted לעולם לא נקראים — אין דרך לעקוף את ה-gate מתוך execute —");
  {
    let beforeCalled = false;
    let executedCalled = false;
    let executeCalled = false;
    const tool = fakeTool({
      name: "denied_tool",
      requiredPermission: "finance:manage",
      execute: async () => {
        executeCalled = true;
        return { ok: true };
      },
    });
    const result = await dispatchToolDefinition(tool, {}, { user: dov }, {
      onBeforeExecute: () => {
        beforeCalled = true;
      },
      onExecuted: () => {
        executedCalled = true;
      },
      onDenied: (t) => assert(t.name === "denied_tool", "onDenied מקבל את הכלי הנכון"),
    });
    assert(!executeCalled && !beforeCalled && !executedCalled, "דחייה: לא execute, לא onBeforeExecute, לא onExecuted");
    assert(result.sideEffect === false, "דחייה ⇒ sideEffect:false");
  }

  // ───────────────────────── onError: נקרא, onExecuted לא נקרא, content/format ─────────────────────────
  logger.info("— שגיאה בתוך execute: onError נקרא עם השגיאה האמיתית, onExecuted לא נקרא, טקסט ברירת מחדל/מותאם —");
  {
    let capturedErr: Error | null = null;
    let executedCalled = false;
    const tool = fakeTool({
      name: "throwing_tool",
      execute: async () => {
        throw new Error("בום");
      },
    });
    const resultDefault = await dispatchToolDefinition(tool, {}, { user: moti }, {
      onError: (_t, err) => {
        capturedErr = err;
      },
      onExecuted: () => {
        executedCalled = true;
      },
    });
    const gotErr = capturedErr as Error | null;
    assert(gotErr?.message === "בום", "onError מקבל את ה-Error האמיתי מ-tool.execute");
    assert(!executedCalled, "onExecuted לא נקרא כש-execute זרק");
    assert(resultDefault.content === "שגיאה: בום", "ברירת מחדל formatError: `שגיאה: ${msg}` — טקסט Web's");
    assert(resultDefault.sideEffect === false, "שגיאה ⇒ sideEffect:false");

    const resultCustom = await dispatchToolDefinition(tool, {}, { user: moti }, {
      formatError: (t, err) => `שגיאה בהרצת ${t.name}: ${err.message}`,
    });
    assert(resultCustom.content === "שגיאה בהרצת throwing_tool: בום", "formatError מותאם — טקסט WhatsApp's");
  }

  // ───────────────────────── formatDenied מותאם (WhatsApp's wording) ─────────────────────────
  {
    const tool = fakeTool({ name: "denied_tool2", requiredPermission: "finance:manage" });
    const result = await dispatchToolDefinition(tool, {}, { user: dov }, {
      formatDenied: (t) => `שגיאה: למשתמש אין הרשאה להשתמש בכלי ${t.name}.`,
    });
    assert(result.content === "שגיאה: למשתמש אין הרשאה להשתמש בכלי denied_tool2.", "formatDenied מותאם — טקסט WhatsApp's (שונה מ-Web's)");
  }

  // ───────────────────────── 5. אפיון authorization semantics של WhatsApp confirmed-execution (לפני/אחרי) ─────────────────────────
  // מוכיח שהחלפת הבדיקה הישנה (tool.requiredPermission בודד) ב-isToolAllowedForUser (דרך
  // dispatchToolDefinition) לא משנה תוצאה לאף כלי requiresConfirmation:true אמיתי קיים — התנאי:
  // (א) אין לאף אחד מהם agentTool (אז isToolAllowedForUser מצטמצם לאותה נוסחה בדיוק), ו-
  // (ב) בפועל, לכל 5 התפקידים, התוצאה זהה.
  logger.info("— WhatsApp confirmed-execution: isToolAllowedForUser === הבדיקה הישנה (tool.requiredPermission), לכל כלי requiresConfirmation אמיתי, לכל role —");
  const confirmableTools = whatsappTools.filter((t) => t.requiresConfirmation === true);
  assert(confirmableTools.length === 5, `בדיוק 5 כלי requiresConfirmation:true ב-WhatsApp כיום (בפועל ${confirmableTools.length})`);
  function oldConfirmedExecutionCheck(tool: ToolDefinition, user: IdentifiedUser | null): boolean {
    // ההיפך של התנאי שהיה ב-messageHandler.ts לפני המעבר (true = מורשה לבצע).
    return !(tool.requiredPermission && !(user?.permissions.includes(tool.requiredPermission) ?? false));
  }
  for (const tool of confirmableTools) {
    assert(tool.agentTool === undefined, `${tool.name}: אין agentTool — isToolAllowedForUser מצטמצם ל-requiredPermission בודד (אותה נוסחה בדיוק)`);
    for (const user of [moti, dov, ruchama, goldi, yochi]) {
      const newDecision = isToolAllowedForUser(tool, user);
      const oldDecision = oldConfirmedExecutionCheck(tool, user);
      assert(newDecision === oldDecision, `${tool.name} confirmed-execution permission עבור ${user.key}: isToolAllowedForUser === הבדיקה הישנה (${newDecision})`);
    }
    assert(isToolAllowedForUser(tool, null) === oldConfirmedExecutionCheck(tool, null), `${tool.name}: null user — אותה תוצאה (false)`);
  }

  // ───────────────────────── ctx מועבר כמו שהוא ל-execute (אין mutation/שינוי shape) ─────────────────────────
  {
    const ctx: ToolContext = { user: yochi };
    let receivedCtx: ToolContext | null = null;
    const tool = fakeTool({
      name: "ctx_passthrough",
      execute: async (_input: Record<string, unknown>, c: ToolContext) => {
        receivedCtx = c;
        return { ok: true };
      },
    });
    await dispatchToolDefinition(tool, {}, ctx);
    assert(receivedCtx === ctx, "ה-ctx המועבר ל-tool.execute הוא בדיוק אותו אובייקט שהועבר לדיספצ'ר — אין עטיפה/שינוי");
  }

  // ───────────────────────── rawInput undefined/null → {} (לא קורס) ─────────────────────────
  {
    let receivedInput: unknown = "unset";
    const tool = fakeTool({
      name: "input_normalize",
      execute: async (input: Record<string, unknown>) => {
        receivedInput = input;
        return { ok: true };
      },
    });
    await dispatchToolDefinition(tool, undefined, { user: moti });
    assert(typeof receivedInput === "object" && receivedInput !== null, "rawInput=undefined ⇒ מנורמל ל-{} — לא מועבר undefined ל-tool.execute");
  }

  if (failures > 0) {
    logger.error(`\n${failures} בדיקות נכשלו ❌`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-shared-dispatcher עברו ✅");
}

main().catch((err) => {
  logger.error(err, "כשל לא צפוי בהרצת הבדיקות");
  process.exit(1);
});
