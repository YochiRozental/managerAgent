/**
 * שכבת ה-Provider — טיפוסים אחידים שמפרידים את שאר המערכת מ-Anthropic / OpenAI.
 *
 * runOrchestrator ו-runOpsChat עובדים אך ורק מול הטיפוסים האלה. כל provider (anthropic.ts /
 * openai.ts) מתרגם הלוך-ושוב בין הפורמט הזה לפורמט של ה-SDK שלו.
 *
 * הפורמט הפנימי דומה למודל ה-blocks של Anthropic (text / tool_use / tool_result) כי זה מה
 * שכבר היה בקוד — אבל הוא ניטרלי, וה-adapter של OpenAI ממפה אותו ל-messages/tool_calls.
 */

export type ProviderName = "anthropic" | "openai";

export const AI_PROVIDERS: readonly ProviderName[] = ["anthropic", "openai"] as const;

export function isProviderName(v: unknown): v is ProviderName {
  return v === "anthropic" || v === "openai";
}

/** הגדרת כלי בפורמט ניטרלי. `parameters` = אובייקט JSON Schema (כמו שכבר קיים אצלנו). */
export interface NormTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type NormContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string };

export interface NormMessage {
  role: "user" | "assistant";
  content: string | NormContentBlock[];
}

export interface NormToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface NormUsage {
  inputTokens: number;
  outputTokens: number;
  /** טוקני input שנקראו מ-cache (Anthropic: cache_read; OpenAI: prompt cached_tokens). 0 אם אין. */
  cachedInputTokens: number;
}

export interface RunModelParams {
  model: string;
  system: string;
  messages: NormMessage[];
  tools: NormTool[];
  maxTokens: number;
}

export interface RunModelResult {
  /** טקסט התשובה של המודל (עשוי להיות "" אם המודל רק קרא לכלים) */
  text: string;
  /** קריאות כלים שהמודל מבקש לבצע */
  toolCalls: NormToolCall[];
  /**
   * תור ה-assistant שיש להוסיף לתמלול הרץ *לפני* תוצאות הכלים.
   * הלולאה שומרת אותו כמו שהוא ומעבירה אותו הלאה — כל adapter יודע להמיר אותו חזרה.
   */
  assistantContent: NormContentBlock[];
  usage: NormUsage;
}

/** ממשק אחיד לכל ספק. */
export interface LlmProvider {
  readonly name: ProviderName;
  runModel(params: RunModelParams): Promise<RunModelResult>;
}
