/**
 * Shared tool-registry primitives — Step 3F.2 (2026-10-07), extract-don't-rewrite.
 *
 * integrations/claude/tools.ts (WhatsApp) has owned ToolDefinition/ToolContext/
 * isToolAllowedForUser since Step 3C — channel-independent concepts that were trapped in a
 * WhatsApp-specific file. This step only relocates them here, with zero logic change, so a
 * later step (3F.3/3F.4) can have Web's own tool list consume the same type and the same
 * permission-filtering function instead of its own ad hoc `if (cond) tools.push(...)` chain.
 * tools.ts re-exports all three so every existing import
 * (`from "../../integrations/claude/tools.js"`) keeps working unchanged.
 *
 * The one type-only adaptation made during the move: `input_schema` is typed
 * `Record<string, unknown>` here (matching AgentTool.input_schema's own shape) instead of
 * `Anthropic.Tool.InputSchema` — src/ai/'s other modules (providers/types.ts) deliberately keep
 * provider-SDK types out of the shared layer, isolated to providers/anthropic.ts. This has zero
 * runtime effect (TypeScript types vanish at compile time); the one place that actually needs
 * the Anthropic-shaped projection (tools.ts's toAnthropicTools) now casts there instead of three
 * individual tool entries casting on the way in.
 *
 * What stays out, deliberately (still WhatsApp-specific, lives in tools.ts):
 *   - the actual `tools: ToolDefinition[]` array (WhatsApp's own 20 tools)
 *   - toAnthropicTools()/getTool() (Anthropic-shaped projection + lookup over that specific array)
 *   - requireIdentifiedUser()/normalizeTaskSource() (WhatsApp-only helpers)
 *   - the subset-of-AgentTool startup validation loop (iterates WhatsApp's own array)
 * Not moved into Web in this step either — ops/chat.ts's own ToolDef{run} shape and its ~28
 * tool entries are untouched; converting them is 3F.3/3F.4, not this one.
 */

import type { IdentifiedUser, Permission } from "../identity/index.js";
import type { AgentTool } from "../ops/agentTools.js";

/** הקשר הרצה שמוזרק לכלי — מי המשתמש ששאל. */
export interface ToolContext {
  user: IdentifiedUser | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Visible to others / hard to undo — must be confirmed by the user before executing (wired in M7). */
  requiresConfirmation: boolean;
  /**
   * ההרשאה שהמשתמש חייב להחזיק כדי להריץ את הכלי. אם לא מוגדר — מספיק להיות מזוהה.
   * האכיפה ב-orchestrator לפני הרצת הכלי. כשהכלי מגובה ב-agentTool (למטה): אם requiredPermission
   * מוגדר, הוא צמצום מכוון של ה-ANY-of של ה-AgentTool (נבדק כ-subset ב-startup, ב-tools.ts);
   * אם לא מוגדר, ה-ANY-of המלא של ה-AgentTool חל ישירות — ר' isToolAllowedForUser.
   */
  requiredPermission?: Permission;
  /**
   * קישור גנרי (שלב 3C) לכלי משותף ב-registry (ops/agentTools.ts) — לא תלוי בשם הכלי. כשמוגדר,
   * ה-AgentTool הוא מקור האמת להרשאות הכלי (ר' isToolAllowedForUser) — לא עוד שתי השוואות הרשאה
   * נפרדות שרק "קורה" להן להסכים.
   */
  agentTool?: AgentTool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any, ctx: ToolContext) => Promise<unknown>;
}

/**
 * מקור האמת היחיד לקביעת "האם המשתמש רשאי להשתמש בכלי הזה" — משמש גם לחשיפה וגם לאכיפה לפני
 * הרצה, כדי שלא יהיו שתי השוואות נפרדות שרק "קורה" להן להסכים. כלי המגובה ב-agentTool (שלב 3C):
 * ה-ANY-of שלו הוא ה-source of truth — requiredPermission כאן, אם מוגדר, מצמצם אליו; אם לא
 * מוגדר, ה-ANY-of המלא של ה-AgentTool חל. כלי בלי agentTool: requiredPermission בודד, או תמיד
 * מורשה אם לא מוגדר.
 */
export function isToolAllowedForUser(tool: ToolDefinition, user: IdentifiedUser | null): boolean {
  if (tool.agentTool) {
    const allowedPermissions: Permission[] = tool.requiredPermission
      ? [tool.requiredPermission]
      : tool.agentTool.requiredPermission;
    return user ? allowedPermissions.some((p) => user.permissions.includes(p)) : false;
  }
  if (!tool.requiredPermission) return true;
  return user ? user.permissions.includes(tool.requiredPermission) : false;
}
