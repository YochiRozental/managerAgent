/**
 * Provider adapter ל-OpenAI GPT (openai SDK, Chat Completions API + function calling).
 *
 * ה-Chat Completions API הוא ה-API היציב והנתמך הרחב ביותר ל-tool calling, וממופה 1:1
 * לפורמט הפנימי שלנו (system + user/assistant + tool). פונקציות ההמרה מיוצאות בנפרד
 * כדי שאפשר יהיה לבדוק אותן בלי SDK אמיתי.
 */

import OpenAI from "openai";
import { env } from "../../config/env.js";
import type {
  LlmProvider,
  NormContentBlock,
  NormMessage,
  NormTool,
  NormToolCall,
  RunModelParams,
  RunModelResult,
} from "./types.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY חסר — נדרש כדי להשתמש ב-provider openai");
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

export function toOpenAiTools(tools: NormTool[]): ChatTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function safeParseArgs(raw: string): unknown {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // המודל הפיק JSON לא תקין — נותנים לכלי לקבל אובייקט ריק ולהחזיר שגיאת ולידציה משלו
    return {};
  }
}

/** ממיר הודעות פנימיות ל-messages של OpenAI. ה-system נכנס כהודעה ראשונה. */
export function toOpenAiMessages(system: string, messages: NormMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as ChatMessage);
      continue;
    }

    if (m.role === "assistant") {
      let text = "";
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] = [];
      for (const b of m.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = { role: "assistant" };
      if (text) msg.content = text;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // role === "user" עם blocks: tool_result → הודעות role:"tool"; text → role:"user"
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
      } else if (b.type === "text") {
        out.push({ role: "user", content: b.text });
      }
    }
  }

  return out;
}

export function fromOpenAiResponse(res: OpenAI.Chat.Completions.ChatCompletion): RunModelResult {
  const choice = res.choices[0];
  const msg = choice?.message;
  const text = msg?.content ?? "";

  const toolCalls: NormToolCall[] = [];
  const assistantContent: NormContentBlock[] = [];
  if (text) assistantContent.push({ type: "text", text });

  for (const tc of msg?.tool_calls ?? []) {
    if (tc.type !== "function") continue;
    const input = safeParseArgs(tc.function.arguments);
    toolCalls.push({ id: tc.id, name: tc.function.name, input });
    assistantContent.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }

  return {
    text,
    toolCalls,
    assistantContent,
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cachedInputTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export const openaiProvider: LlmProvider = {
  name: "openai",
  async runModel(params: RunModelParams): Promise<RunModelResult> {
    const res = await getClient().chat.completions.create({
      model: params.model,
      max_completion_tokens: params.maxTokens,
      messages: toOpenAiMessages(params.system, params.messages),
      ...(params.tools.length > 0 ? { tools: toOpenAiTools(params.tools) } : {}),
    });
    return fromOpenAiResponse(res);
  },
};
