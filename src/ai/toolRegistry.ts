/**
 * Shared tool-registry primitives — Step 3F.2 (2026-10-07), extract-don't-rewrite.
 * Extended Step 3F.3 (2026-10-07): requireIdentifiedUser moved here too, once Web's own
 * create_lead ToolDefinition needed the exact same null→guaranteed-user narrowing WhatsApp
 * already had — proof it was channel-independent all along, not WhatsApp-specific.
 *
 * integrations/claude/tools.ts (WhatsApp) has owned ToolDefinition/ToolContext/
 * isToolAllowedForUser/requireIdentifiedUser since Step 3C — channel-independent concepts that
 * were trapped in a WhatsApp-specific file. This relocates them here, with zero logic change, so
 * Web's own tool list can consume the same type and the same permission-filtering function
 * instead of its own ad hoc `if (cond) tools.push(...)` chain (ops/chat.ts's create_lead did
 * exactly that in Step 3F.3 — see its own comments). tools.ts re-exports all of them so every
 * existing import (`from "../../integrations/claude/tools.js"`) keeps working unchanged.
 *
 * The one type-only adaptation made during the 3F.2 move: `input_schema` is typed
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
 *   - normalizeTaskSource() (WhatsApp-only helper — list_my_work's label mismatch)
 *   - the subset-of-AgentTool startup validation loop (iterates WhatsApp's own array)
 * Step 3F.3 converted exactly one of Web's entries (create_lead) to prove the pattern; its other
 * ~27 tool entries (8 remaining AgentTool-backed ones + ~19 Web-local ones) are untouched —
 * converting the rest is 3F.4+, not this step.
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
  /**
   * Central Agent Core unification (2026-10-07) — הפרמיטיב החסר שהאודיט הקודם (read-only
   * dispatcher audit) זיהה: הדיספצ'ר המשותף (ai/dispatcher.ts) צריך לדעת, מה-data ולא מ-channel/
   * מיקום-קוד/שם-כלי, אם לאכוף isToolAllowedForUser בזמן ההרצה. ברירת המחדל (undefined ⇒ true)
   * משמרת בדיוק את ההתנהגות הקיימת היום בשני הערוצים: Web's executeToolCall וגם WhatsApp's
   * executeToolCall מריצים את הבדיקה הזו *ללא יוצא מן הכלל* על כל ToolDefinition שהם מריצים (ר'
   * audit — אין היום שום ToolDefinition בפועל, בשני הערוצים, שמדלג על הבדיקה הזו). אף כלי קיים לא
   * מקבל false במעבר הזה — כולל חמשת כלי ה-Web "התמיד-גלויים" (mark_done/set_status/add_note/
   * report_blocker/add_update): ה-discrepancy המתועד שלהם הוא *build-time visibility* בלבד (אם
   * tools.push מותנה) — לא execution-time enforcement, שכבר חל עליהם היום ללא תנאי, ותואם
   * (אותם בני-אדם נדחים) לבדיקת ההרשאה הראשונה שגם ops/actions.ts's authorize()/addUpdateToItem
   * עצמם מבצעים. false שמור לעתיד, אם ייווצר כלי שבאמת צריך לדלג על הבדיקה הזו במכוון.
   */
  enforceExecutionTimePermission?: boolean;
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

/**
 * הופכת ToolContext.user (IdentifiedUser | null) למשתמש מזוהה ודאי, לפני העברתו ל-AgentTool
 * (AgentToolContext דורש IdentifiedUser לא-nullable). שימוש: כל ToolDefinition.execute שמגובה
 * ב-agentTool וצריך להעביר user אמיתי. הועבר לכאן משלב 3F.2 (היה ב-integrations/claude/tools.ts
 * בלבד) כש-Step 3F.3 הראה שגם Web צריך בדיוק את זה — לא רק WhatsApp. שמירה מפורשת (לא bypass,
 * לא ניחוש): אם ctx.user חסר, זורקת מיד — לא ממשיכה בשקט עם משתמש מומצא/ברירת-מחדל.
 */
export function requireIdentifiedUser(ctx: ToolContext): IdentifiedUser {
  if (!ctx.user) throw new Error("חסר הקשר משתמש — לא ניתן לבצע את הפעולה בלי לדעת מי שואל.");
  return ctx.user;
}
