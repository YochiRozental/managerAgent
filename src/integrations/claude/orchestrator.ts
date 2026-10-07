import { runRoutedAgent } from "../../ai/routedAgent.js";
import { buildSystemPrompt } from "../../ai/prompt.js";
import { dispatchToolDefinition } from "../../ai/dispatcher.js";
import type { NormTool, NormToolCall } from "../../ai/providers/types.js";
import type { IdentifiedUser } from "../../identity/index.js";
import { logger } from "../../utils/logger.js";
import { getTool, isToolAllowedForUser, toAnthropicTools } from "./tools.js";

const MAX_TOOL_TURNS = 8;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type OrchestratorResult =
  | { type: "text"; text: string }
  | { type: "confirm"; toolName: string; input: unknown };

export async function runOrchestrator(
  history: ConversationMessage[],
  user: IdentifiedUser | null = null,
): Promise<OrchestratorResult> {
  // המשתמש רואה רק כלים שמותרים לו. defense-in-depth: גם לפני הרצה בפועל נבדוק שוב.
  const availableTools = toAnthropicTools(user);
  const normTools: NormTool[] = availableTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: (t.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));

  // שלב 3C: מקור האמת היחיד לבדיקת הרשאה (isToolAllowedForUser, tools.ts) — לא עוד השוואה
  // מקבילה נפרדת כאן. תואם בדיוק להתנהגות הקודמת: כלי לא קיים ⇒ אין requiredPermission ⇒ מורשה
  // (dead code בפועל — executeToolCall/screenToolCalls בודקים existence קודם).
  const canUseTool = (name: string): boolean => {
    const tool = getTool(name);
    if (!tool) return true;
    return isToolAllowedForUser(tool, user);
  };

  const buildLoop = () => ({
    system: buildSystemPrompt({ channel: "whatsapp", user }),
    maxTokens: 1024,
    maxTurns: MAX_TOOL_TURNS,
    messages: history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    tools: normTools,
    // פעולות גלויות / הרסניות — עוצרים לפני הרצה, מחזירים לאישור המשתמש. שום כלי מהתור הזה לא רץ.
    screenToolCalls: (calls: NormToolCall[]) => {
      const needsConfirm = calls.find((c) => getTool(c.name)?.requiresConfirmation);
      if (!needsConfirm) return null;
      if (!canUseTool(needsConfirm.name)) return { reason: "denied" };
      return { reason: "confirm", payload: { toolName: needsConfirm.name, input: needsConfirm.input } };
    },
    // Central Agent Core unification (2026-10-07): ההרצה בפועל עברה ל-dispatchToolDefinition
    // (src/ai/dispatcher.ts) — אותו דיספצ'ר ש-Web's ops/chat.ts גם קורא לו. canUseTool (מעל) נשאר
    // קיים ומשמש את screenToolCalls בלבד — כאן הוא לא עוד נבדק בנפרד: הדיספצ'ר מבצע את אותה בדיקה
    // (isToolAllowedForUser) בעצמו, פנימית, על אותו tool/user — אין כפילות, אין שינוי תוצאה.
    executeToolCall: async (call: NormToolCall) => {
      const tool = getTool(call.name);
      if (!tool) return { content: `שגיאה: כלי לא ידוע ${call.name}`, sideEffect: false };
      return dispatchToolDefinition(tool, call.input, { user }, {
        onDenied: () => logger.warn({ tool: call.name, user: user?.key ?? "unidentified" }, "כלי נחסם — אין למשתמש הרשאה"),
        formatDenied: () => `שגיאה: למשתמש אין הרשאה להשתמש בכלי ${call.name}.`,
        onBeforeExecute: () => logger.info({ tool: call.name, input: call.input, user: user?.key }, "מריץ כלי"),
        onError: (_t, err) => logger.error(err, `כלי ${call.name} נכשל`),
        formatError: (_t, err) => `שגיאה בהרצת ${call.name}: ${err.message}`,
      });
    },
  });

  const routed = await runRoutedAgent({
    useCase: "whatsapp_orchestrator",
    latestMessage: history[history.length - 1]?.content ?? "",
    historyLength: history.length,
    canSeeAllWork: user?.permissions.includes("view:all_work") ?? false,
    buildLoop,
  });
  const { outcome } = routed;

  if (outcome.halted?.reason === "confirm") {
    const { toolName, input } = outcome.halted.payload as { toolName: string; input: unknown };
    return { type: "confirm", toolName, input };
  }
  if (outcome.halted?.reason === "denied") {
    return { type: "text", text: "אין לך הרשאה לבצע את הפעולה הזו." };
  }
  return {
    type: "text",
    text: outcome.text ?? "מצטער/ת, לקח יותר מדי צעדים לענות על הבקשה הזו. אפשר לנסח מחדש בקצרה?",
  };
}
