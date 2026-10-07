/**
 * Central Agent Core unification — Step 3F.6 (2026-10-07): ONE shared construction mechanism for
 * AgentTool-backed ToolDefinitions, replacing the two independently hand-authored wrapper
 * patterns that Web (ops/chat.ts) and WhatsApp (integrations/claude/tools.ts) each grew on their
 * own since Step 3B/3C/3D/3E/3F.3-3F.5B.
 *
 * Phase 1 read-only comparison (audit before this step) of the 5 AgentTool-backed tools present
 * on BOTH channels today — create_task, create_lead, mark_done, set_status, add_update — found:
 *   - name/description/input_schema: identical on both channels for create_task/mark_done/
 *     set_status (both just use the AgentTool's own values verbatim). Genuinely DIFFERENT by
 *     design for create_lead (WhatsApp exposes a narrower 7-field schema + its own shorter
 *     description, deliberately omitting `assignee` — Step 3B) and add_update (WhatsApp calls it
 *     "add_monday_update", exposes only 2 of the AgentTool's 3 fields — no `label` — and narrows
 *     requiredPermission to "task:update_own" instead of the AgentTool's full 5-permission ANY-of).
 *   - execute wiring: identical pattern on both channels (requireIdentifiedUser(ctx) then
 *     agentTool.execute(input, {user})) — EXCEPT WhatsApp's mark_done/set_status additionally run
 *     normalizeTaskSource(input) first (list_my_work's office/project display-label aliasing,
 *     integrations/claude/tools.ts) — a genuine, intentional per-channel input transform.
 *   - agentTool backing, requiresConfirmation (always false today): identical on both channels.
 * This module's SharedToolProjection captures exactly those four axes of intentional divergence
 * (name/description/input_schema/requiredPermission) plus the one input-transform divergence
 * found (transformInput) — nothing invented beyond what current code actually does.
 *
 * What this module owns: building one ToolDefinition from one AgentTool (+ optional per-channel
 * projection), and the one "always visible regardless of permission vs. normal permission-gated"
 * visibility split that Web's 5 "historically unconditional" tools need (ToolVisibilityPolicy) —
 * ported from scattered `if (isToolAllowedForUser(...)) tools.push(...)` call sites into one
 * explicit, data-declared policy per tool, exactly preserving which tools were unconditional and
 * which were gated (see ops/chat.ts's WEB_SHARED_TOOL_VISIBILITY for the declared table).
 *
 * What stays OUT, deliberately: which AgentTools each channel actually wires in (Web: 9, WhatsApp:
 * 5 — a channel/product decision, not this module's business), WhatsApp's own uniform
 * isToolAllowedForUser filter over its whole static tools[] array (toAnthropicTools — unrelated
 * to Web's unconditional/gated split, needs no change here), legacy/local tools on either side,
 * execution (dispatchToolDefinition, src/ai/dispatcher.ts — a separate concern from construction).
 */
import { AGENT_TOOLS, type AgentTool } from "../ops/agentTools.js";
import type { IdentifiedUser, Permission } from "../identity/index.js";
import { isToolAllowedForUser, requireIdentifiedUser, type ToolContext, type ToolDefinition } from "./toolRegistry.js";

/**
 * מאתר AgentTool לפי שם ב-registry המשותף (ops/agentTools.ts), וזורק מיידית אם חסר — תקלת-חיווט
 * תיתפס בעליית השרת, לא בשקט באמצע שיחה. channelLabel רק לטקסט השגיאה (זהה בדיוק למה שהיה קודם
 * בכל ערוץ בנפרד — "חיבור Web שבור" / "חיבור WhatsApp שבור"), כדי שההודעה תמשיך להצביע נכון על
 * הערוץ שבו קרתה התקלה גם אחרי שהפונקציה הפכה למשותפת.
 */
export function requireAgentTool(name: string, channelLabel: string): AgentTool {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`AgentTool '${name}' לא נמצא ב-registry המשותף (ops/agentTools.ts) — חיבור ${channelLabel} שבור.`);
  return tool;
}

/**
 * כל מה שערוץ יכול להצהיר במכוון שונה מה-AgentTool עצמו. לא מגדיל capability surface — רק
 * מבטא את ההבדלים שכבר קיימים היום בפועל (ר' docstring בראש הקובץ). שדה שלא מוצהר ⇒ נופל
 * ל-AgentTool's own value, זהה למה שהיה בכל 7 הכלים שלא היה להם projection עד היום.
 */
export interface SharedToolProjection {
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  /** צמצום מכוון של ה-ANY-of של ה-AgentTool לערוץ הזה בלבד (למשל WhatsApp's add_monday_update). */
  requiredPermission?: Permission;
  /** טרנספורמציה של ה-input לפני agentTool.execute (למשל WhatsApp's normalizeTaskSource). */
  transformInput?: (input: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * בונה ToolDefinition אחד מ-AgentTool אחד — מחליף את תשעת האובייקטים שהיו בנויים ביד ב-chat.ts
 * וחמשת האובייקטים שהיו בנויים ביד ב-tools.ts, כולם באותו דפוס מילה-במילה (requireIdentifiedUser
 * ואז agentTool.execute). requiresConfirmation קבוע ל-false — כל כלי AgentTool-backed קיים היום
 * הוא false; פרויקציה עתידית תצטרך שדה חדש אם ייווצר כלי שבאמת צריך true.
 */
export function buildSharedToolDefinition(agentTool: AgentTool, projection: SharedToolProjection = {}): ToolDefinition {
  return {
    name: projection.name ?? agentTool.name,
    description: projection.description ?? agentTool.description,
    input_schema: projection.input_schema ?? agentTool.input_schema,
    requiresConfirmation: false,
    requiredPermission: projection.requiredPermission,
    agentTool,
    execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const user = requireIdentifiedUser(ctx);
      const finalInput = projection.transformInput ? projection.transformInput(input) : input;
      return agentTool.execute(finalInput, { user });
    },
  };
}

/**
 * "תמיד מורשה" (Web's 5 כלים התמיד-גלויים, documented discrepancy מ-3F.5B — ANY-of ה-AgentTool
 * לא מכיל את כל התפקידים שראו את הכלי היום) מול "gated" (isToolAllowedForUser הרגיל). זו ה-policy
 * שהייתה מובלעת ב"יש if או אין if" סביב tools.push — כאן היא נתון מוצהר, לא נגזרת מצורת הקוד.
 */
export type ToolVisibilityPolicy = "always" | "gated";

export interface SharedToolVisibilityEntry {
  tool: ToolDefinition;
  visibility: ToolVisibilityPolicy;
}

/**
 * המסנן המשותף היחיד לכלי AgentTool-backed עם visibility policy מוצהר. היום רק Web צריך את
 * הפיצול הזה בפועל (ל-WhatsApp אין כלי "תמיד-גלוי" — ה-filter הקיים שלו מעל כל tools[] שלו,
 * toAnthropicTools, ממשיך לעבוד בלי שינוי ולא דורש את הפונקציה הזו).
 */
export function filterSharedToolsForUser(entries: SharedToolVisibilityEntry[], user: IdentifiedUser | null): ToolDefinition[] {
  return entries.filter((e) => e.visibility === "always" || isToolAllowedForUser(e.tool, user)).map((e) => e.tool);
}
