/**
 * Central Agent Core unification — Step 3F.7B (2026-10-07): the last two genuinely-duplicated
 * one-liners the 3F.7A audit found between ops/chat.ts and integrations/claude/orchestrator.ts —
 * normalizing channel history into NormMessage[], and a channel's tool list into NormTool[] for
 * the model. Both channels did the exact same transform by hand; this is the one place that does
 * it now. Deliberately provider-agnostic — no Anthropic/OpenAI-specific types in here, matching
 * the rest of src/ai/'s shared layer (providers/types.ts's NormMessage/NormTool already are the
 * neutral shapes both provider adapters translate to/from).
 */
import type { NormMessage, NormTool } from "./providers/types.js";

/** Both ops/chat.ts's ChatMessage and orchestrator.ts's ConversationMessage already have this shape. */
export interface ChannelMessage {
  role: "user" | "assistant";
  content: string;
}

export function toNormMessages(history: ChannelMessage[]): NormMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * description/input_schema optional here (not on ToolDefinition itself) only so this one function
 * can serve both call sites: Web's tools always have both; WhatsApp's toAnthropicTools(user) result
 * is typed Anthropic.Tool, where the SDK marks them optional even though every real ToolDefinition
 * always provides them — the defaults below exactly reproduce orchestrator.ts's prior inline
 * `?? ""` / `?? {type:"object",properties:{}}`, which never actually triggers for Web's tools.
 */
export interface ChannelToolLike {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export function toNormTools(tools: ChannelToolLike[]): NormTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));
}
