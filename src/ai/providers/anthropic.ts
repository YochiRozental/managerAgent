/**
 * Provider adapter ל-Anthropic Claude (@anthropic-ai/sdk).
 *
 * הפורמט הפנימי (types.ts) כמעט זהה למודל ה-blocks של Anthropic, אז ההמרה כאן דקה.
 * פונקציות ההמרה מיוצאות בנפרד כדי שאפשר יהיה לבדוק אותן בלי SDK אמיתי.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";
import type {
  LlmProvider,
  NormContentBlock,
  NormMessage,
  NormTool,
  RunModelParams,
  RunModelResult,
} from "./types.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY חסר — נדרש כדי להשתמש ב-provider anthropic");
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export function toAnthropicTools(tools: NormTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicContent(blocks: NormContentBlock[]): Anthropic.ContentBlockParam[] {
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input as object };
    return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content };
  });
}

export function toAnthropicMessages(messages: NormMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : toAnthropicContent(m.content),
  }));
}

export function fromAnthropicResponse(res: Anthropic.Message): RunModelResult {
  const assistantContent: NormContentBlock[] = [];
  let text = "";
  const toolCalls: RunModelResult["toolCalls"] = [];

  for (const block of res.content) {
    if (block.type === "text") {
      text += block.text;
      assistantContent.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
      assistantContent.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
  }

  return {
    text,
    toolCalls,
    assistantContent,
    usage: {
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      cachedInputTokens: res.usage?.cache_read_input_tokens ?? 0,
      // ניסוי Prompt Caching (2026-10-14) — טוקנים שנכתבו ל-cache בבקשה הזו (cache miss שיצר entry).
      cacheCreationInputTokens: res.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * ניסוי Prompt Caching (2026-10-14) — בונה system כמערך 2 בלוקים (קבוע עם cache_control, אחריו
 * המשתנה) ומסמן את הכלי האחרון ב-tools, לפי סדר ה-prefix של Anthropic (tools→system→messages —
 * מאומת מול התיעוד הרשמי, 2026-10-14). משתמש ב-TTL ברירת המחדל (5 דק') — לא 1h, לא בניסוי הזה.
 * מחזיר tools כ-undefined אם אין כלים כלל (כמו ההתנהגות הקיימת — tools לא נשלח אם ריק).
 *
 * תיקון (2026-10-15, audit לפני הפעלה): Anthropic מחברת כמה בלוקי-טקסט של system *בלי* מפריד
 * משלהם — ה-text של כל בלוק מצורף כמו שהוא. בלי "\n\n" כאן, שורת התאריך (הבלוק השני) הייתה
 * מתחברת תו-בתו לסוף המשפט האחרון של ההוראות הקבועות (למשל "...ותציע צעד הבא.היום יום חמישי...").
 * ה-"\n\n" נוסף כאן, בשכבת ה-wire-format ל-Anthropic — לא ב-prompt.ts's buildWebPromptCacheSplit,
 * ש-volatile שלה נשאר התאריך הגולמי (צרכן אחר, promptCachingExperiment.test.ts, בודק אותו ישירות).
 *
 * זו גם פשרה מכוונת, לא רק באג: שורת התאריך יושבת *בסוף* כל ה-system (לא במיקומה המקורי, שורה
 * שנייה בתחילת ה-prompt, כמו ב-buildWebPrompt הרגיל בלי caching) — כי cache_control מבוסס על
 * prefix matching לפי סדר הבלוקים; אם תוכן משתנה-כל-דקה (התאריך) היה *לפני* הבלוק הקבוע, כל
 * בקשה הייתה מקבלת hash-prefix אחר ואף פעם לא היה נוצר cache hit. ה-"\n\n" מתקן את ההפרדה
 * החזותית/סמנטית (לא "דבוק" למשפט הקודם) בלי לנסות להחזיר את התאריך למיקומו המקורי — זה היה
 * מבטל את כל יתרון ה-caching, שינוי התנהגות גדול בהרבה מהתיקון הנקודתי הזה.
 */
export function applyPromptCaching(
  system: string,
  tools: Anthropic.Tool[] | undefined,
  promptCaching: NonNullable<RunModelParams["promptCaching"]>,
): { system: string | Anthropic.TextBlockParam[]; tools: Anthropic.Tool[] | undefined } {
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: promptCaching.cacheableSystem, cache_control: { type: "ephemeral" } },
    { type: "text", text: `\n\n${promptCaching.volatileSystemSuffix}` },
  ];
  if (tools && tools.length > 0) {
    const markedTools = tools.slice();
    markedTools[markedTools.length - 1] = { ...markedTools[markedTools.length - 1]!, cache_control: { type: "ephemeral" } };
    return { system: systemBlocks, tools: markedTools };
  }
  return { system: systemBlocks, tools };
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  async runModel(params: RunModelParams): Promise<RunModelResult> {
    const toolsParam = params.tools.length > 0 ? toAnthropicTools(params.tools) : undefined;
    let system: string | Anthropic.TextBlockParam[] = params.system;
    let tools = toolsParam;
    if (params.promptCaching) {
      ({ system, tools } = applyPromptCaching(params.system, toolsParam, params.promptCaching));
    }
    const res = await getClient().messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system,
      messages: toAnthropicMessages(params.messages),
      ...(tools ? { tools } : {}),
    });
    return fromAnthropicResponse(res);
  },
};
