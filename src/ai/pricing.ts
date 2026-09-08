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
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // ── Anthropic (אומת 2026-09-08) ──
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
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
  /** טוקנים שנקראו מ-cache — מחושבים כ-input מלא (הערכה שמרנית) */
  cachedInputTokens?: number;
}

/**
 * עלות משוערת בדולרים, או null אם אין מחיר ידוע למודל.
 * הערכה בלבד: cache-read מחושב כ-input במחיר מלא, בלי הנחות tier/batch.
 */
export function estimateCostUsd(model: string, usage: CostInput): number | null {
  const price = MODEL_PRICING[model];
  if (!price) return null;
  const inputTok = usage.inputTokens + (usage.cachedInputTokens ?? 0);
  return (inputTok / 1_000_000) * price.inputPerMTok + (usage.outputTokens / 1_000_000) * price.outputPerMTok;
}
