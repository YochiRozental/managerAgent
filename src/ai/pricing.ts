/**
 * מחירון מודלים — מקור אמת יחיד לחישוב עלות משוערת בלוגים.
 *
 * כל המחירים list price ל-1M tokens (USD), **אומתו מול התיעוד הרשמי ב-2026-09-08**:
 *   Anthropic — https://platform.claude.com/docs/en/about-claude/pricing
 *   OpenAI    — https://developers.openai.com/api/docs/pricing
 *
 * מודל שלא מופיע כאן → `estimateCostUsd` מחזיר null (לא ממציאים / לא מעריכים מחיר).
 * להוספת מודל — לאמת מול הקישורים למעלה ולהוסיף שורה, לא לנחש.
 */

export interface ModelPrice {
  /** USD ל-1M input tokens */
  inputPerMTok: number;
  /** USD ל-1M output tokens */
  outputPerMTok: number;
  /**
   * מחירי Prompt Caching (Anthropic) — אומתו מול platform.claude.com/docs, 2026-10-14, ל-Haiku 4.5
   * בלבד (ניסוי ה-cache, ר' ops/chat.ts's PROMPT_CACHING_EXPERIMENT_ENABLED). אופציונליים
   * בכוונה: מודל בלי השדות האלה ממשיך לחשב cache-read/write כ-input מלא (הערכה שמרנית, בדיוק
   * ההתנהגות הקיימת לפני היום — estimateCostUsd למטה). cacheWrite5mPerMTok הוא TTL ברירת המחדל
   * (5 דק') — הניסוי לא משתמש ב-1h, אז אין צורך גם במחיר הזה כרגע.
   */
  cacheReadPerMTok?: number;
  cacheWrite5mPerMTok?: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // ── Anthropic (אומת 2026-09-08; מחירי cache אומתו בנפרד מול platform.claude.com/docs 2026-10-14) ──
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25 },
  // Sonnet 5: מחיר ה"מבוא" $2/$10 הפך למחיר הקבוע (העלאה ל-$3/$15 בוטלה).
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  // Opus 5: $5/$25 (המחיר הישן $15/$75 שייך ל-Opus 4.1 שיצא משימוש).
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },

  // ── OpenAI (אומת מול developers.openai.com/api/docs/pricing, 2026-09-08) ──
  "gpt-5.4-mini": { inputPerMTok: 0.75, outputPerMTok: 4.5 },
  "gpt-5.4-nano": { inputPerMTok: 0.2, outputPerMTok: 1.25 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
  "gpt-5-nano": { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4.1-nano": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  /** טוקנים שנקראו מ-cache (hit). בלי cacheReadPerMTok מוגדר למודל — מחושבים כ-input מלא (הערכה שמרנית). */
  cachedInputTokens?: number;
  /** ניסוי Prompt Caching (2026-10-14) — טוקנים שנכתבו ל-cache (miss שיצר entry). בלי cacheWrite5mPerMTok מוגדר — מחושבים כ-input מלא. */
  cacheCreationInputTokens?: number;
}

/** true ⇐ יש מחיר cache מדויק (לא הערכה) למודל הזה — ר' logAiCall's cost_exact. */
export function hasCachePricing(model: string): boolean {
  const p = MODEL_PRICING[model];
  return !!p && p.cacheReadPerMTok != null && p.cacheWrite5mPerMTok != null;
}

/**
 * עלות משוערת בדולרים, או null אם אין מחיר ידוע למודל.
 * cache-read/write מחושבים במחיר המדויק אם ידוע (cacheReadPerMTok/cacheWrite5mPerMTok); אחרת
 * כ-input במחיר מלא (הערכה שמרנית, בלי הנחות tier/batch) — זהו אותו fallback שהיה כאן תמיד,
 * ולכן ללא השפעה על קריאות קיימות (cachedInputTokens=0 תמיד עד היום).
 */
export function estimateCostUsd(model: string, usage: CostInput): number | null {
  const price = MODEL_PRICING[model];
  if (!price) return null;
  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const readRate = price.cacheReadPerMTok ?? price.inputPerMTok;
  const writeRate = price.cacheWrite5mPerMTok ?? price.inputPerMTok;
  const inputCost = (usage.inputTokens / 1_000_000) * price.inputPerMTok;
  const readCost = (cacheRead / 1_000_000) * readRate;
  const writeCost = (cacheWrite / 1_000_000) * writeRate;
  const outputCost = (usage.outputTokens / 1_000_000) * price.outputPerMTok;
  return inputCost + readCost + writeCost + outputCost;
}
