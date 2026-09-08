/**
 * נקודת הכניסה לשכבת ה-Provider. שאר המערכת קוראת רק ל-`runModel()` ולא יודעת אם
 * מאחורי הקלעים רץ Anthropic או OpenAI.
 */

import { logger } from "../../utils/logger.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import type { LlmProvider, ProviderName, RunModelParams, RunModelResult } from "./types.js";

const PROVIDERS: Record<ProviderName, LlmProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export function getProvider(name: ProviderName): LlmProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`ספק AI לא מוכר: "${name}". תקפים: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

/**
 * קריאה בודדת למודל דרך הספק הנבחר. שגיאות ה-SDK נעטפות עם provider+model כדי שהלוג יהיה ברור
 * (בלי לחשוף מפתחות/תוכן).
 */
export async function runModel(
  params: RunModelParams & { provider: ProviderName },
): Promise<RunModelResult> {
  const { provider, ...rest } = params;
  try {
    return await getProvider(provider).runModel(rest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ provider, model: params.model }, "קריאת מודל נכשלה");
    throw new Error(`[${provider}/${params.model}] ${msg}`);
  }
}

export { AI_PROVIDERS, isProviderName } from "./types.js";
export type {
  LlmProvider,
  NormContentBlock,
  NormMessage,
  NormTool,
  NormToolCall,
  NormUsage,
  ProviderName,
  RunModelParams,
  RunModelResult,
} from "./types.js";
