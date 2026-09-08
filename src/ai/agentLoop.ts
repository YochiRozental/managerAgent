/**
 * לולאת ה-tool-use המשותפת — provider-agnostic.
 *
 * שני ה-call-sites (runOrchestrator, runOpsChat) משתמשים בזה. הלוגיקה העסקית (איזה כלים,
 * הרשאות, אישורים, מעקב כתיבות) נשארת אצלם דרך callbacks — כאן רק מבנה הלולאה:
 *   קריאה למודל → אם אין tool calls, סיום → אחרת: להריץ כלים, לצרף תוצאות, שוב.
 *
 * מונע:
 *  - ביצוע כלי כפול: כל tool call מורץ פעם אחת, וה-loop לא רץ מחדש על עצמו.
 *  - קריאת AI כפולה מיותרת: הלולאה עוצרת ברגע שהמודל מפסיק לקרוא לכלים.
 *    (ה-fallback ל-SMART הוא באחריות ה-call-site, עם shouldEscalateToSmart.)
 */

import { logger } from "../utils/logger.js";
import { addUsage, newUsageAcc, type UsageAcc } from "./models.js";
import { runModel } from "./providers/index.js";
import type {
  NormContentBlock,
  NormMessage,
  NormTool,
  NormToolCall,
  ProviderName,
} from "./providers/types.js";

/** חתימת פונקציית הקריאה למודל — מוזרקת בבדיקות במקום ה-runModel האמיתי. */
export type RunModelFn = typeof runModel;

export interface AgentHalt {
  reason: string;
  payload?: unknown;
}

export interface ToolCallOutcome {
  /** תוכן ה-tool_result שיוחזר למודל */
  content: string;
  /** האם הקריאה גרמה לתופעת לוואי (כתיבה ל-Monday / פעולה חיצונית) — קובע אם מותר fallback */
  sideEffect: boolean;
}

export interface AgentLoopParams {
  provider: ProviderName;
  model: string;
  system: string;
  maxTokens: number;
  maxTurns: number;
  /** התמלול ההתחלתי — מועתק, לא משתנה במקום */
  messages: NormMessage[];
  tools: NormTool[];
  /** מריץ קריאת כלי אחת. לא אמור לזרוק — יחזיר content עם הודעת שגיאה במקום. */
  executeToolCall: (call: NormToolCall) => Promise<ToolCallOutcome>;
  /**
   * נקרא אחרי שהמודל ביקש כלים, לפני הרצתם. אם מחזיר ערך — הלולאה נעצרת מיד
   * ומחזירה אותו ב-`halted`, בלי להריץ אף כלי. (זרימת האישור ב-orchestrator.)
   */
  screenToolCalls?: (calls: NormToolCall[]) => AgentHalt | null;
  /**
   * נקרא כשהמודל סיים בלי לקרוא לכלים. אם מחזיר string — הוא מוחזר במקום הטקסט של המודל.
   * (הגשת תדריך הבוקר מילה-במילה ב-runOpsChat.)
   */
  finalizeText?: (modelText: string) => string | null;
  /** לבדיקות בלבד — הזרקת פונקציית קריאה למודל במקום ה-runModel האמיתי. */
  _runModel?: RunModelFn;
}

export interface AgentLoopResult {
  /** התשובה הסופית, או null אם לא הופקה (שגיאה / נגמרו הסבבים / halted) */
  text: string | null;
  halted: AgentHalt | null;
  /** כמה קריאות כלים בוצעו בפועל */
  toolCallCount: number;
  /** כמה מהן דיווחו על תופעת לוואי */
  sideEffects: number;
  turns: number;
  exhausted: boolean;
  errored: boolean;
  usage: UsageAcc;
}

function cloneMessage(m: NormMessage): NormMessage {
  return { role: m.role, content: typeof m.content === "string" ? m.content : m.content.map((b) => ({ ...b })) };
}

export async function runAgentLoop(p: AgentLoopParams): Promise<AgentLoopResult> {
  const callModel = p._runModel ?? runModel;
  const usage = newUsageAcc();
  const messages: NormMessage[] = p.messages.map(cloneMessage);
  let toolCallCount = 0;
  let sideEffects = 0;
  let turns = 0;

  for (let i = 0; i < p.maxTurns; i++) {
    turns = i + 1;

    let result;
    try {
      result = await callModel({
        provider: p.provider,
        model: p.model,
        system: p.system,
        messages,
        tools: p.tools,
        maxTokens: p.maxTokens,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "agentLoop: קריאת מודל נכשלה");
      return { text: null, halted: null, toolCallCount, sideEffects, turns, exhausted: false, errored: true, usage };
    }
    addUsage(usage, result.usage);

    if (result.toolCalls.length === 0) {
      const finalText = p.finalizeText ? p.finalizeText(result.text) : result.text;
      return {
        text: finalText || null,
        halted: null,
        toolCallCount,
        sideEffects,
        turns,
        exhausted: false,
        errored: false,
        usage,
      };
    }

    const halt = p.screenToolCalls?.(result.toolCalls) ?? null;
    if (halt) {
      return { text: null, halted: halt, toolCallCount, sideEffects, turns, exhausted: false, errored: false, usage };
    }

    messages.push({ role: "assistant", content: result.assistantContent });

    const resultBlocks: NormContentBlock[] = [];
    for (const call of result.toolCalls) {
      let outcome: ToolCallOutcome;
      try {
        outcome = await p.executeToolCall(call);
      } catch (err) {
        outcome = { content: `שגיאה: ${(err as Error).message}`, sideEffect: false };
      }
      toolCallCount += 1;
      if (outcome.sideEffect) sideEffects += 1;
      resultBlocks.push({ type: "tool_result", toolUseId: call.id, content: outcome.content });
    }
    messages.push({ role: "user", content: resultBlocks });
  }

  return { text: null, halted: null, toolCallCount, sideEffects, turns, exhausted: true, errored: false, usage };
}
