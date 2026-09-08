/**
 * ניתוב מודלים מרכזי — המקום היחיד שבו מוגדרים שמות מודלים ושבו מחליטים FAST מול SMART.
 *
 * הרעיון (בקשת מוטי/יוכי, 2026-09-08): במקום לשלוח כל בקשה למודל היקר, מנתבים דטרמיניסטית:
 *   FAST  = Claude Haiku  — שאלות עובד רגילות, קריאת מידע, עדכוני סטטוס, tool-use פשוט, סיכומים קצרים.
 *   SMART = Claude Sonnet — ניתוח מצב, תכנון סדר עבודה, זיהוי חריגות, החלטה בין אפשרויות, בקשות עמומות/ארוכות.
 *
 * אין כאן קריאת AI נוספת רק כדי לבחור מודל — הבחירה היא לפי סוג הפעולה, הרשאות המשתמש וטקסט הבקשה.
 *
 * שמות מודלים תקפים (לפי ה-SDK והסביבה): "claude-haiku-4-5-20251001", "claude-sonnet-5".
 * ניתן לעקוף דרך משתני סביבה MODEL_FAST / MODEL_SMART אם Anthropic משחררת מודל חדש.
 */

import { logger } from "../utils/logger.js";

export type ModelTier = "fast" | "smart";
export type AiUseCase = "ops_chat" | "whatsapp_orchestrator";

export const DEFAULT_MODEL_FAST = "claude-haiku-4-5-20251001";
export const DEFAULT_MODEL_SMART = "claude-sonnet-5";

export interface ModelConfig {
  fast: string;
  smart: string;
  /** האם ללוגג עלות משוערת (ברירת מחדל: כן; כבה עם AI_COST_LOGGING=false) */
  costLogging: boolean;
}

/** פונקציה טהורה — מקבלת מקור env ומחזירה קונפיג. מופרד כדי שאפשר לבדוק גם ערכים חלופיים. */
export function resolveModelConfig(source: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    fast: source.MODEL_FAST?.trim() || DEFAULT_MODEL_FAST,
    smart: source.MODEL_SMART?.trim() || DEFAULT_MODEL_SMART,
    costLogging: (source.AI_COST_LOGGING ?? "true").toLowerCase() !== "false",
  };
}

export const modelConfig: ModelConfig = resolveModelConfig();

export function modelForTier(tier: ModelTier, cfg: ModelConfig = modelConfig): string {
  return tier === "smart" ? cfg.smart : cfg.fast;
}

// ───────────────────────── בחירת מודל (דטרמיניסטית) ─────────────────────────

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
  model: string;
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
    return { tier: "fast", model: modelForTier("fast"), reason: "trivial" };
  }

  const tier: ModelTier = reasons.length > 0 ? "smart" : "fast";
  return {
    tier,
    model: modelForTier(tier),
    reason: reasons.length > 0 ? reasons.join(",") : "default-simple",
  };
}

/**
 * האם להסלים מ-FAST ל-SMART אחרי ניסיון ראשון. דטרמיניסטי, בלי קריאת AI.
 * מסלימים רק אם: השתמשנו ב-FAST, הניסיון נכשל (שגיאה / אין תשובה / נגמרו הסבבים),
 * ו*לא* בוצעו תופעות לוואי (כתיבות ל-Monday / הרצת כלים) — אחרת retry יכפיל פעולות.
 * זה גם מה שמונע קריאת AI שנייה מיותרת: אם FAST הצליח או שכבר רצו כלים — לא מסלימים.
 */
export function shouldEscalateToSmart(params: {
  attemptedTier: ModelTier;
  failed: boolean;
  sideEffectsCount: number;
}): boolean {
  return params.attemptedTier === "fast" && params.failed && params.sideEffectsCount === 0;
}

// ───────────────────────── מדידת usage ועלות ─────────────────────────

export interface UsageAcc {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function newUsageAcc(): UsageAcc {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function addUsage(acc: UsageAcc, usage: RawUsage | null | undefined): void {
  if (!usage) return;
  acc.input += usage.input_tokens ?? 0;
  acc.output += usage.output_tokens ?? 0;
  acc.cacheRead += usage.cache_read_input_tokens ?? 0;
  acc.cacheWrite += usage.cache_creation_input_tokens ?? 0;
}

/**
 * מחירון Anthropic ל-1M tokens (USD) — list price נכון לתחילת 2026. אם המחירים משתנים — לעדכן כאן.
 * מודל שלא במפה → לא מחשבים עלות (מחזירים null), רק מדווחים tokens.
 */
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
};

/** עלות משוערת בדולרים, או null אם אין מחיר ידוע למודל. הערכה בלבד (cache-read מחושב כ-input מלא — שמרני). */
export function estimateCostUsd(model: string, usage: UsageAcc): number | null {
  const p = PRICING_PER_MTOK[model];
  if (!p) return null;
  const inputTok = usage.input + usage.cacheRead;
  return (inputTok / 1_000_000) * p.input + (usage.output / 1_000_000) * p.output;
}

// ───────────────────────── logging ─────────────────────────

export interface AiCallLog {
  useCase: AiUseCase;
  tier: ModelTier;
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
 * tier, model, use case, tokens, ועלות משוערת.
 */
export function logAiCall(entry: AiCallLog): void {
  const cost = modelConfig.costLogging ? estimateCostUsd(entry.model, entry.usage) : null;
  logger.info(
    {
      ai_call: true,
      use_case: entry.useCase,
      tier: entry.tier,
      model: entry.model,
      route_reason: entry.routeReason,
      fallback_to_smart: entry.fallback,
      turns: entry.turns,
      input_tokens: entry.usage.input,
      output_tokens: entry.usage.output,
      cache_read_tokens: entry.usage.cacheRead,
      ...(cost != null ? { est_cost_usd: Number(cost.toFixed(5)) } : {}),
    },
    `AI ${entry.tier}/${entry.model} · ${entry.useCase}${entry.fallback ? " (fallback→smart)" : ""}`,
  );
}
