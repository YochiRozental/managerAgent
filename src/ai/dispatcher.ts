/**
 * Central Agent Core — ONE shared ToolDefinition execution dispatcher (unification step,
 * 2026-10-07), built directly on the read-only dispatcher audit done at HEAD 8e8a14f.
 *
 * Owns only the generic execution concerns that Web's executeToolCall (ops/chat.ts) and
 * WhatsApp's executeToolCall (integrations/claude/orchestrator.ts) already performed
 * identically, in parallel, before this step:
 *
 *   resolved ToolDefinition → normalize input → optional execution-time permission
 *   enforcement (isToolAllowedForUser, gated by the new ToolDefinition.enforceExecutionTime
 *   Permission flag — see toolRegistry.ts) → tool.execute(input, ctx) → normalized
 *   {content, sideEffect} result → normalized error handling.
 *
 * Deliberately does NOT know about (these stay exactly where they were, wired through the
 * optional hooks below so each channel's exact current text/ordering/side effects are
 * reproduced by the *caller*, never baked into this module):
 *   - Web's actions[] / refresh() / SHARED_TOOL_UI_EFFECT (ops/chat.ts)
 *   - WhatsApp's JIDs / pendingActions / screenToolCalls confirmation protocol
 *   - Web's manager_approvals / Policy Engine (ops/loopReply.ts)
 *   - any channel-specific logging text or UI strings
 *
 * Both callers' tool-not-found handling stays outside this function too — Web needs to find
 * the tool in a mixed array of legacy ToolDef/shared ToolDefinition (isSharedToolDefinition),
 * WhatsApp looks it up in its own static array (getTool) — that lookup/branch is channel
 * plumbing, not a generic execution concern. Callers pass in an already-resolved ToolDefinition.
 */
import { isToolAllowedForUser, type ToolContext, type ToolDefinition } from "./toolRegistry.js";

export interface DispatchResult {
  content: string;
  /** true ⇔ tool.execute() ran to completion without being denied or throwing. */
  sideEffect: boolean;
}

export interface DispatchHooks {
  /** נקרא לפני tool.execute, רק אם עבר את בדיקת ההרשאה. */
  onBeforeExecute?: (tool: ToolDefinition, input: Record<string, unknown>, ctx: ToolContext) => void;
  /** נקרא אחרי tool.execute מוצלח — המקום של Web's actions.push/refresh(), לא כאן בכלל. */
  onExecuted?: (
    tool: ToolDefinition,
    result: unknown,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ) => void | Promise<void>;
  /** נקרא כש-execution-time permission check דוחה את הקריאה (לפני tool.execute). */
  onDenied?: (tool: ToolDefinition, ctx: ToolContext) => void;
  /** נקרא כש-tool.execute זורק. */
  onError?: (tool: ToolDefinition, err: Error, ctx: ToolContext) => void;
  /** טקסט דחייה מוחזר למודל — ברירת מחדל זהה למה ש-Web הציג; WhatsApp מעביר formatter משלו. */
  formatDenied?: (tool: ToolDefinition) => string;
  /** טקסט שגיאה מוחזר למודל — ברירת מחדל `שגיאה: ${msg}` (Web's text); WhatsApp מעביר formatter משלו. */
  formatError?: (tool: ToolDefinition, err: Error) => string;
}

export async function dispatchToolDefinition(
  tool: ToolDefinition,
  rawInput: unknown,
  ctx: ToolContext,
  hooks: DispatchHooks = {},
): Promise<DispatchResult> {
  const input = (rawInput ?? {}) as Record<string, unknown>;

  const enforce = tool.enforceExecutionTimePermission ?? true;
  if (enforce && !isToolAllowedForUser(tool, ctx.user)) {
    hooks.onDenied?.(tool, ctx);
    const content = hooks.formatDenied ? hooks.formatDenied(tool) : `שגיאה: אין הרשאה להשתמש בכלי ${tool.name}.`;
    return { content, sideEffect: false };
  }

  try {
    hooks.onBeforeExecute?.(tool, input, ctx);
    const result = await tool.execute(input, ctx);
    if (hooks.onExecuted) await hooks.onExecuted(tool, result, input, ctx);
    return { content: JSON.stringify(result), sideEffect: true };
  } catch (err) {
    hooks.onError?.(tool, err as Error, ctx);
    const content = hooks.formatError ? hooks.formatError(tool, err as Error) : `שגיאה: ${(err as Error).message}`;
    return { content, sideEffect: false };
  }
}
