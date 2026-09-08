/**
 * ה-router — בוחר FAST מול SMART לפי סוג הבקשה, ומודד usage / עלות / לוגים.
 *
 * חשוב: ה-router בוחר **רק tier** (fast/smart). התרגום ל-provider ול-model נעשה ב-tierConfig.ts
 * לפי משתני סביבה. הבחירה כאן דטרמיניסטית — אין קריאת AI רק כדי להחליט איזה מודל.
 *
 * FAST  — שאלות עובד רגילות, קריאת מידע, עדכוני סטטוס, tool-use פשוט, סיכומים קצרים.
 * SMART — ניתוח מצב, תכנון סדר עבודה, זיהוי חריגות, החלטה בין אפשרויות, בקשות עמומות/ארוכות.
 */

import { logger } from "../utils/logger.js";
import { estimateCostUsd } from "./pricing.js";
import { aiConfig } from "./tierConfig.js";
import type { NormUsage, ProviderName } from "./providers/types.js";

export type ModelTier = "fast" | "smart";
export type AiUseCase = "ops_chat" | "whatsapp_orchestrator";

// ───────────────────────── בחירת tier (דטרמיניסטית) ─────────────────────────

/**
 * מילות מפתח שמעידות על צורך ב-reasoning אמיתי — תכנון, ניתוח, השוואה, קבלת החלטה, תעדוף.
 * שמרני בכוונה: עדיף לפספס כמה מקרים ל-FAST (עם fallback) מאשר לשלוח הכל ל-SMART.
 */
const ANALYTICAL_PATTERN =
  /(נתח|ניתוח|תכנן|תכנון|סדר עבודה|תעדף|לתעדף|תעדוף|עדיפויות|השווה|השוואה|לעומת|מה ההבדל|תמליץ|המלצ|אסטרטג|כדאי|עדיף|להחליט|מה עדיף|צפי קדימה|תחזית|למה זה|מדוע|analyz|plan\b|compare|prioriti|strateg|decide|recommend)/i;

/** שאלות "בקרה־על" של מי שרואה את כל המשרד — דורשות סינתזה של הרבה מידע. */
const OVERSIGHT_PATTERN =
  /(מה תקוע|מה דורש|מה דחוף|מה המצב|תמונת מצב|סקירה|מה קורה אצל|מצב המכירות|מצב הגבייה|מצב הפרויקט|איזה פרויקטים|כל המשרד|מה בסיכון|בקרה)/;

export interface RouteContext {
  useCase: AiUseCase;
  /** ההודעה האחרונה של המשתמש (טקסט חופשי) */
  latestMessage: string;
  /** מספר ההודעות בהיסטוריית השיחה עד כה */
  historyLength: number;
  /** האם למשתמש יש ראיית כל-המשרד (מוטי/יוכי) */
  canSeeAllWork: boolean;
}

export interface RouteDecision {
  tier: ModelTier;
  /** למה נבחר ה-tier הזה — נכנס ללוג, לא חושף תוכן */
  reason: string;
}

export function chooseModelForTask(ctx: RouteContext): RouteDecision {
  const text = (ctx.latestMessage ?? "").trim();
  const reasons: string[] = [];

  if (text.length > 220) reasons.push("long-message");
  if (ANALYTICAL_PATTERN.test(text)) reasons.push("analytical-keywords");
  if (ctx.canSeeAllWork && OVERSIGHT_PATTERN.test(text)) reasons.push("oversight-question");
  if (ctx.historyLength >= 14) reasons.push("deep-conversation");

  // ברכה / אישור קצר ("בוקר טוב", "כן", "תודה") — FAST, אלא אם יש אות אחר למורכבות.
  const isShort = text.length <= 12 && !ANALYTICAL_PATTERN.test(text);
  if (isShort && reasons.length === 0) {
    return { tier: "fast", reason: "trivial" };
  }

  return {
    tier: reasons.length > 0 ? "smart" : "fast",
    reason: reasons.length > 0 ? reasons.join(",") : "default-simple",
  };
}

/**
 * האם להסלים מ-FAST ל-SMART אחרי ניסיון ראשון. דטרמיניסטי, בלי קריאת AI.
 * מסלימים רק אם: השתמשנו ב-FAST, הניסיון נכשל (שגיאה / אין תשובה / נגמרו הסבבים),
 * ו*לא* בוצעו תופעות לוואי (כתיבות ל-Monday / הרצת כלים) — אחרת retry יכפיל פעולות.
 * זה גם מה שמונע קריאת AI שנייה מיותרת: אם FAST הצליח או שכבר רצו כלים — לא מסלימים.
 * עובד ללא תלות בספקים — SMART יכול להיות provider אחר מ-FAST.
 */
export function shouldEscalateToSmart(params: {
  attemptedTier: ModelTier;
  failed: boolean;
  sideEffectsCount: number;
}): boolean {
  return params.attemptedTier === "fast" && params.failed && params.sideEffectsCount === 0;
}

// ───────────────────────── מדידת usage ─────────────────────────

export interface UsageAcc {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function newUsageAcc(): UsageAcc {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

export function addUsage(acc: UsageAcc, usage: NormUsage | null | undefined): void {
  if (!usage) return;
  acc.inputTokens += usage.inputTokens ?? 0;
  acc.outputTokens += usage.outputTokens ?? 0;
  acc.cachedInputTokens += usage.cachedInputTokens ?? 0;
}

// ───────────────────────── logging ─────────────────────────

export interface AiCallLog {
  useCase: AiUseCase;
  tier: ModelTier;
  provider: ProviderName;
  model: string;
  usage: UsageAcc;
  turns: number;
  /** האם הייתה הסלמה מ-FAST ל-SMART */
  fallback: boolean;
  /** תיאור קצר של סיבת הניתוב (מ-RouteDecision.reason) */
  routeReason?: string;
}

/**
 * לוג לכל קריאת AI — בלי תוכן הודעות, בלי מפתחות/סודות. רק מטא-דאטה תפעולי:
 * tier, provider, model, use case, tokens, ועלות משוערת (אם המחיר ידוע).
 */
export function logAiCall(entry: AiCallLog): void {
  const cost = aiConfig.costLogging
    ? estimateCostUsd(entry.model, {
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        cachedInputTokens: entry.usage.cachedInputTokens,
      })
    : null;
  logger.info(
    {
      ai_call: true,
      use_case: entry.useCase,
      tier: entry.tier,
      provider: entry.provider,
      model: entry.model,
      route_reason: entry.routeReason,
      fallback_to_smart: entry.fallback,
      turns: entry.turns,
      input_tokens: entry.usage.inputTokens,
      output_tokens: entry.usage.outputTokens,
      cached_tokens: entry.usage.cachedInputTokens,
      ...(cost != null ? { est_cost_usd: Number(cost.toFixed(5)) } : {}),
    },
    `AI ${entry.tier}/${entry.provider}/${entry.model} · ${entry.useCase}${entry.fallback ? " (fallback→smart)" : ""}`,
  );
}
