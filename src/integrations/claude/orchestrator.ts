import { DateTime } from "luxon";
import { env } from "../../config/env.js";
import { runRoutedAgent } from "../../ai/routedAgent.js";
import type { NormTool, NormToolCall } from "../../ai/providers/types.js";
import type { IdentifiedUser } from "../../identity/index.js";
import { logger } from "../../utils/logger.js";
import { getTool, toAnthropicTools } from "./tools.js";

const MAX_TOOL_TURNS = 8;

function systemPrompt(user: IdentifiedUser | null): string {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const lines = [
    "את/ה סוכן אישי בעברית שעוזר/ת לנהל משימות (דרך Monday.com), לתעד פגישות ולשלוח זימוני יומן ומיילים (דרך Google).",
    `התאריך והשעה כרגע: ${now.toFormat("yyyy-MM-dd HH:mm")} (אזור זמן ${env.TIMEZONE}).`,
    "תמיד ענה/עני בעברית, בקצרה וברור.",
  ];

  if (user) {
    lines.push(
      "",
      `המשתמש שמולך: ${user.name}. תפקיד: ${user.role} — ${user.roleDescription}`,
      "פעל/י רק לפי ההרשאות של המשתמש. הכלים שנחשפו לך כבר מסוננים להרשאותיו — אם משימה דורשת פעולה שאין לה כלי זמין, אמור/י שאין למשתמש הרשאה לכך ואל תנסה/י לעקוף.",
    );
  } else {
    lines.push("", "המשתמש לא זוהה. אל תבצע/י פעולות ואל תחשוף/י מידע — בקש/י מהמשתמש להזדהות.");
  }

  lines.push(
    "",
    "כשמבקשים ממך להוסיף משימה, נסה/י לאתר את הלוח הרלוונטי עם find_monday_board לפי הקשר הבקשה; אם לא ברור לאיזה לוח/פרויקט הכוונה, שאל/י לפני שיוצרים.",
    "כשמבקשים 'מה יש לי לעשות', 'המשימות שלי', 'מה על הפרק', 'מה עליי לבצע היום' וכדומה - השתמש/י ב-list_my_work: תדריך קומפקטי ומתועדף של העבודה של המשתמש עצמו להיום (עד 30 פריטים) + summary עם הספירות המלאות. לא ב-list_monday_tasks של לוח בודד.",
    "ליצירת אירוע ביומן או שליחת מייל תמיד צריך כתובת מייל של הנמען/המשתתף — אם אין לך אותה, בקש/י אותה מהמשתמש.",
  );

  return lines.join("\n");
}

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

  const canUseTool = (name: string): boolean => {
    const perm = getTool(name)?.requiredPermission;
    if (!perm) return true;
    return user?.permissions.includes(perm) ?? false;
  };

  const buildLoop = () => ({
    system: systemPrompt(user),
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
    executeToolCall: async (call: NormToolCall) => {
      const tool = getTool(call.name);
      if (!tool) return { content: `שגיאה: כלי לא ידוע ${call.name}`, sideEffect: false };
      if (!canUseTool(call.name)) {
        logger.warn({ tool: call.name, user: user?.key ?? "unidentified" }, "כלי נחסם — אין למשתמש הרשאה");
        return { content: `שגיאה: למשתמש אין הרשאה להשתמש בכלי ${call.name}.`, sideEffect: false };
      }
      try {
        logger.info({ tool: call.name, input: call.input, user: user?.key }, "מריץ כלי");
        const result = await tool.execute(call.input, { user });
        return { content: JSON.stringify(result), sideEffect: true };
      } catch (err) {
        logger.error(err, `כלי ${call.name} נכשל`);
        return { content: `שגיאה בהרצת ${call.name}: ${(err as Error).message}`, sideEffect: false };
      }
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
