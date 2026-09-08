/**
 * תצורת ה-tiers — ממפה FAST / SMART ל-{provider, model} לפי משתני סביבה.
 *
 * ברירת מחדל (production כמו היום — לא שוברים כלום אם לא מגדירים כלום):
 *   FAST  = anthropic / claude-haiku-4-5-20251001
 *   SMART = anthropic / claude-sonnet-5
 *
 * לשינוי — משתני סביבה בלבד, בלי לגעת בקוד:
 *   AI_FAST_PROVIDER=openai   AI_FAST_MODEL=gpt-4o-mini
 *   AI_SMART_PROVIDER=anthropic   AI_SMART_MODEL=claude-sonnet-5
 *
 * `MODEL_FAST` / `MODEL_SMART` (השמות הישנים) עדיין נתמכים כ-alias ל-AI_*_MODEL.
 *
 * ה-router (chooseModelForTask) בוחר רק FAST/SMART ולא יודע כלום על provider/model —
 * הבחירה הזו מתורגמת כאן.
 */

import { AI_PROVIDERS, isProviderName, type ProviderName } from "./providers/types.js";
import type { ModelTier } from "./models.js";

export interface TierConfig {
  provider: ProviderName;
  model: string;
}

export interface AiConfig {
  fast: TierConfig;
  smart: TierConfig;
  /** האם ללוגג עלות משוערת (ברירת מחדל: כן; כבה עם AI_COST_LOGGING=false) */
  costLogging: boolean;
}

const DEFAULTS: Record<ModelTier, TierConfig> = {
  fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  smart: { provider: "anthropic", model: "claude-sonnet-5" },
};

/** override אופציונלי — נועד למסך ניהול עתידי שיכתוב ערכים מעל ה-env. */
export interface AiConfigOverride {
  fast?: Partial<TierConfig>;
  smart?: Partial<TierConfig>;
  costLogging?: boolean;
}

function resolveTier(
  source: NodeJS.ProcessEnv,
  tier: "FAST" | "SMART",
  override: Partial<TierConfig> | undefined,
  def: TierConfig,
): TierConfig {
  // ריק / לא-מוגדר → ברירת מחדל. מוגדר-לא-תקין → שגיאה ברורה.
  const rawProvider = (override?.provider || source[`AI_${tier}_PROVIDER`]?.trim() || def.provider).toLowerCase();
  if (!isProviderName(rawProvider)) {
    throw new Error(
      `AI_${tier}_PROVIDER לא תקין: "${rawProvider}". ערכים תקפים: ${AI_PROVIDERS.join(", ")}`,
    );
  }
  const model =
    override?.model?.trim() ||
    source[`AI_${tier}_MODEL`]?.trim() ||
    source[`MODEL_${tier}`]?.trim() || // alias לשמות הישנים
    def.model;
  return { provider: rawProvider, model };
}

/**
 * פונקציה טהורה — מקבלת מקור env (+override אופציונלי) ומחזירה תצורה מלאה.
 * מיובאת גם ע"י הבדיקות עם מקורות מזויפים.
 */
export function resolveAiConfig(
  source: NodeJS.ProcessEnv = process.env,
  override?: AiConfigOverride,
): AiConfig {
  return {
    fast: resolveTier(source, "FAST", override?.fast, DEFAULTS.fast),
    smart: resolveTier(source, "SMART", override?.smart, DEFAULTS.smart),
    costLogging:
      override?.costLogging ?? ((source.AI_COST_LOGGING ?? "true").toLowerCase() !== "false"),
  };
}

/** תצורה חיה — נקראת פעם אחת בטעינת המודול. */
export const aiConfig: AiConfig = resolveAiConfig();

export function tierConfig(tier: ModelTier, cfg: AiConfig = aiConfig): TierConfig {
  return cfg[tier];
}
