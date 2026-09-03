import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { env } from "../../config/env.js";
import type { IdentifiedUser } from "../../identity/index.js";
import { logger } from "../../utils/logger.js";
import { getTool, toAnthropicTools } from "./tools.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-5";
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
    "כשמבקשים 'מה יש לי לעשות', 'המשימות שלי', 'מה על הפרק' וכדומה - השתמש/י ב-list_my_work, שמרכז את כל המשימות מכל הלוחות (מקביל לתצוגת 'My Work' במאנדיי), ולא ב-list_monday_tasks של לוח בודד.",
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
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));

  // המשתמש רואה רק כלים שמותרים לו. defense-in-depth: גם לפני הרצה בפועל נבדוק שוב.
  const availableTools = toAnthropicTools(user);
  const canUseTool = (name: string): boolean => {
    const perm = getTool(name)?.requiredPermission;
    if (!perm) return true;
    return user?.permissions.includes(perm) ?? false;
  };

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(user),
      tools: availableTools,
      messages,
    });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      return { type: "text", text: textBlock?.text ?? "" };
    }

    // Visible/hard-to-undo actions must be confirmed by the user first — pause here without
    // executing anything from this turn, so nothing fires twice once the user replies.
    const needsConfirmation = toolUses.find((tu) => getTool(tu.name)?.requiresConfirmation);
    if (needsConfirmation) {
      if (!canUseTool(needsConfirmation.name)) {
        return { type: "text", text: "אין לך הרשאה לבצע את הפעולה הזו." };
      }
      return { type: "confirm", toolName: needsConfirmation.name, input: needsConfirmation.input };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const tool = getTool(toolUse.name);
      let resultContent: string;
      if (!tool) {
        resultContent = `שגיאה: כלי לא ידוע ${toolUse.name}`;
      } else if (!canUseTool(toolUse.name)) {
        logger.warn(
          { tool: toolUse.name, user: user?.key ?? "unidentified" },
          "כלי נחסם — אין למשתמש הרשאה",
        );
        resultContent = `שגיאה: למשתמש אין הרשאה להשתמש בכלי ${toolUse.name}.`;
      } else {
        try {
          logger.info({ tool: toolUse.name, input: toolUse.input, user: user?.key }, "מריץ כלי");
          const result = await tool.execute(toolUse.input);
          resultContent = JSON.stringify(result);
        } catch (err) {
          logger.error(err, `כלי ${toolUse.name} נכשל`);
          resultContent = `שגיאה בהרצת ${toolUse.name}: ${(err as Error).message}`;
        }
      }
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultContent });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { type: "text", text: "מצטער/ת, לקח יותר מדי צעדים לענות על הבקשה הזו. אפשר לנסח מחדש בקצרה?" };
}
