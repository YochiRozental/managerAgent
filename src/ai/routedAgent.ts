/**
 * מחבר את השלושה: router (בחירת tier) → tierConfig (provider+model) → agentLoop (הרצה) → fallback + logging.
 *
 * שני ה-call-sites (runOrchestrator, runOpsChat) קוראים לזה במקום לחזור על אותה לוגיקת ניתוב.
 * הם רק מספקים `buildLoop(tier)` (איזה כלים / system / איך מריצים כלי) ומפרשים את התוצאה.
 *
 * fallback: ניסיון יחיד FAST→SMART, רק אם FAST נכשל ולא היו תופעות לוואי. אין retry loop.
 * עובד גם כש-FAST ו-SMART הם ספקים שונים.
 */

import { logger } from "../utils/logger.js";
import type { AgentLoopParams, AgentLoopResult, RunModelFn } from "./agentLoop.js";
import { runAgentLoop } from "./agentLoop.js";
import {
  chooseModelForTask,
  logAiCall,
  shouldEscalateToSmart,
  type AiUseCase,
  type ModelTier,
} from "./models.js";
import { aiConfig, type AiConfig } from "./tierConfig.js";
import type { ProviderName } from "./providers/types.js";

type LoopSpec = Omit<AgentLoopParams, "provider" | "model" | "_runModel">;

export interface RoutedAgentParams {
  useCase: AiUseCase;
  latestMessage: string;
  historyLength: number;
  canSeeAllWork: boolean;
  /** בונה את מפרט הלולאה עבור tier נתון. נקרא מחדש לכל ניסיון (כולל ה-fallback). */
  buildLoop: (tier: ModelTier) => LoopSpec;
  /**
   * כמה תופעות לוואי קרו — קובע אם מותר fallback. ברירת מחדל: outcome.sideEffects של הלולאה.
   * runOpsChat דורס את זה עם מספר הכתיבות ל-Monday (actions.length).
   */
  sideEffectCount?: (outcome: AgentLoopResult) => number;
  /** לכפות tier ולעקוף את ה-router — למשל תשובה לפנייה יזומה, ששם דיוק חשוב מעלות. */
  forceTier?: ModelTier;
  /** לבדיקות — תצורת tiers חלופית */
  _config?: AiConfig;
  /** לבדיקות — פונקציית קריאה למודל מזויפת */
  _runModel?: RunModelFn;
}

export interface RoutedAgentResult {
  outcome: AgentLoopResult;
  tier: ModelTier;
  provider: ProviderName;
  model: string;
  fallbackUsed: boolean;
  routeReason: string;
}

export async function runRoutedAgent(p: RoutedAgentParams): Promise<RoutedAgentResult> {
  const cfg = p._config ?? aiConfig;
  const route = p.forceTier
    ? { tier: p.forceTier, reason: `forced:${p.forceTier}` }
    : chooseModelForTask({
        useCase: p.useCase,
        latestMessage: p.latestMessage,
        historyLength: p.historyLength,
        canSeeAllWork: p.canSeeAllWork,
      });
  const sideEffectOf = p.sideEffectCount ?? ((o: AgentLoopResult) => o.sideEffects);

  const runTier = (tier: ModelTier) => {
    const { provider, model } = cfg[tier];
    return runAgentLoop({ ...p.buildLoop(tier), provider, model, _runModel: p._runModel });
  };

  let tier: ModelTier = route.tier;
  let outcome = await runTier(tier);
  logAiCall({
    useCase: p.useCase,
    tier,
    provider: cfg[tier].provider,
    model: cfg[tier].model,
    usage: outcome.usage,
    turns: outcome.turns,
    fallback: false,
    routeReason: route.reason,
  });

  let fallbackUsed = false;
  if (!outcome.halted) {
    const emptyText = !outcome.text || outcome.text.trim() === "";
    const failed = outcome.errored || outcome.exhausted || emptyText;
    if (shouldEscalateToSmart({ attemptedTier: tier, failed, sideEffectsCount: sideEffectOf(outcome) })) {
      logger.info({ use_case: p.useCase, route: route.reason }, "FAST לא הספיק — מסלים ל-SMART פעם אחת");
      tier = "smart";
      fallbackUsed = true;
      outcome = await runTier(tier);
      logAiCall({
        useCase: p.useCase,
        tier,
        provider: cfg.smart.provider,
        model: cfg.smart.model,
        usage: outcome.usage,
        turns: outcome.turns,
        fallback: true,
        routeReason: route.reason,
      });
    }
  }

  return {
    outcome,
    tier,
    provider: cfg[tier].provider,
    model: cfg[tier].model,
    fallbackUsed,
    routeReason: route.reason,
  };
}
