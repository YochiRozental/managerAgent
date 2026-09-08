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
    },
  };
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",
  async runModel(params: RunModelParams): Promise<RunModelResult> {
    const res = await getClient().messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: toAnthropicMessages(params.messages),
      ...(params.tools.length > 0 ? { tools: toAnthropicTools(params.tools) } : {}),
    });
    return fromAnthropicResponse(res);
  },
};
