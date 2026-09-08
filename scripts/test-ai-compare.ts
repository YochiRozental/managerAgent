/**
 * השוואת ספקים/מודלים — מריץ *אותה* בקשה מול שתי תצורות ומדפיס זמן/טוקנים/עלות/tool-calls/הצלחה.
 *
 * ⚠️  READ ONLY כברירת מחדל — לא נוגע ב-Monday / יומן / מייל / שום פעולה חיצונית.
 *     הבקשה נשלחת למודל *בלי כלים* (טקסט בלבד). עם --tools מופעל תת-קבוצה של כלי קריאה
 *     בלבד (list boards / my work / calendar list) — אף פעם לא כלי כתיבה.
 *
 * שימוש:
 *   npm run test:ai-compare
 *   npm run test:ai-compare -- --a anthropic:claude-haiku-4-5-20251001 --b openai:gpt-5.4-mini
 *   npm run test:ai-compare -- --prompt "נסח סיכום קצר של מצב פרויקט תקוע" --tools
 *
 * דורש ANTHROPIC_API_KEY / OPENAI_API_KEY לפי הספקים שנבחרו.
 * הערה: gpt-5.4-mini הוא reasoning model — נותנים כאן תקציב output גדול יותר (2000) כדי
 * שההשוואה תהיה הוגנת (טוקני reasoning נספרים ב-output).
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { runAgentLoop } from "../src/ai/agentLoop.js";
import { estimateCostUsd } from "../src/ai/pricing.js";
import { aiConfig } from "../src/ai/tierConfig.js";
import { isProviderName, type NormTool, type ProviderName } from "../src/ai/providers/types.js";
import { getTool, tools as allTools } from "../src/integrations/claude/tools.js";
import { logger } from "../src/utils/logger.js";

const READ_ONLY_TOOLS = new Set([
  "list_monday_boards",
  "find_monday_board",
  "list_monday_tasks",
  "list_my_work",
  "find_monday_user",
  "list_calendar_events",
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function parseTarget(spec: string | undefined, fallback: { provider: ProviderName; model: string }) {
  if (!spec) return fallback;
  const [p, ...rest] = spec.split(":");
  const provider = (p ?? "").toLowerCase();
  const model = rest.join(":");
  if (!isProviderName(provider) || !model) {
    throw new Error(`--target לא תקין: "${spec}". פורמט: <anthropic|openai>:<model>`);
  }
  return { provider, model };
}

interface RunReport {
  ok: boolean;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCalls: number;
  cost: number | null;
  error?: string;
  preview: string;
}

async function runOne(
  target: { provider: ProviderName; model: string },
  prompt: string,
  withTools: boolean,
): Promise<RunReport> {
  const normTools: NormTool[] = withTools
    ? allTools
        .filter((t) => READ_ONLY_TOOLS.has(t.name))
        .map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> }))
    : [];

  const started = performance.now();
  try {
    const res = await runAgentLoop({
      provider: target.provider,
      model: target.model,
      system: "אתה עוזר תפעולי בעברית של משרד אדריכלים. ענה קצר וברור.",
      maxTokens: Number(arg("max-tokens") ?? 2000),
      maxTurns: Number(arg("turns") ?? 4),
      messages: [{ role: "user", content: prompt }],
      tools: normTools,
      // גם אם המודל יבקש — רק כלי קריאה מותרים, אף פעם לא כתיבה
      executeToolCall: async (call) => {
        if (!READ_ONLY_TOOLS.has(call.name)) {
          return { content: `שגיאה: הכלי ${call.name} חסום בסקריפט ההשוואה (read-only)`, sideEffect: false };
        }
        try {
          const out = await getTool(call.name)!.execute(call.input);
          return { content: JSON.stringify(out), sideEffect: false };
        } catch (err) {
          return { content: `שגיאה: ${(err as Error).message}`, sideEffect: false };
        }
      },
    });
    const ms = performance.now() - started;
    return {
      ok: !res.errored && !!res.text,
      ms,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cachedTokens: res.usage.cachedInputTokens,
      toolCalls: res.toolCallCount,
      cost: estimateCostUsd(target.model, {
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        cachedInputTokens: res.usage.cachedInputTokens,
      }),
      error: res.errored ? "קריאת מודל נכשלה" : res.exhausted ? "נגמרו הסבבים" : undefined,
      preview: (res.text ?? "").replace(/\s+/g, " ").slice(0, 160),
    };
  } catch (err) {
    return {
      ok: false,
      ms: performance.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      toolCalls: 0,
      cost: null,
      error: (err as Error).message,
      preview: "",
    };
  }
}

function printReport(label: string, t: { provider: string; model: string }, r: RunReport) {
  logger.info(`\n━━ ${label}: ${t.provider} / ${t.model} ━━`);
  logger.info(`  ${r.ok ? "✓ הצליח" : "✗ נכשל"}${r.error ? ` (${r.error})` : ""}`);
  logger.info(`  ⏱  ${r.ms.toFixed(0)} ms`);
  logger.info(`  🔤 input: ${r.inputTokens}${r.cachedTokens ? ` (מתוכם ${r.cachedTokens} מ-cache)` : ""} · output: ${r.outputTokens}`);
  logger.info(`  🔧 tool calls: ${r.toolCalls}`);
  logger.info(`  💰 עלות משוערת: ${r.cost != null ? `$${r.cost.toFixed(5)}` : "לא ידוע (מודל לא במחירון)"}`);
  if (r.preview) logger.info(`  💬 ${r.preview}${r.preview.length >= 160 ? "…" : ""}`);
}

async function main() {
  const withTools = hasFlag("tools");
  const prompt =
    arg("prompt") ??
    "יש פרויקט בנייה שתקוע 12 יום כי אין אישור ועדה, ומנהל הפרויקט לא עדכן. נסח בקצרה מה הצעד הבא ואיך להתריע.";
  const a = parseTarget(arg("a"), aiConfig.fast);
  const b = parseTarget(arg("b"), aiConfig.smart);

  logger.info("═══ השוואת AI ═══");
  logger.info(`בקשה: "${prompt}"`);
  logger.info(`כלים: ${withTools ? "כלי קריאה בלבד (list boards / my work / calendar) — לא כותב כלום" : "ללא כלים (טקסט בלבד)"}`);
  if (a.provider === b.provider && a.model === b.model) {
    logger.warn("שתי התצורות זהות — ההשוואה לא מאוד מעניינת. העבר/י --a ו/או --b.");
  }

  const [ra, rb] = await Promise.all([runOne(a, prompt, withTools), runOne(b, prompt, withTools)]);
  printReport("A", a, ra);
  printReport("B", b, rb);

  logger.info("\n━━ סיכום ━━");
  if (ra.ok && rb.ok) {
    const faster = ra.ms < rb.ms ? "A" : "B";
    logger.info(`  מהיר יותר: ${faster} (${Math.abs(ra.ms - rb.ms).toFixed(0)} ms הפרש)`);
    if (ra.cost != null && rb.cost != null) {
      const cheaper = ra.cost < rb.cost ? "A" : "B";
      logger.info(`  זול יותר: ${cheaper}`);
    }
  } else {
    logger.warn("  לפחות תצורה אחת נכשלה — ראה/י פירוט למעלה.");
  }
}

main().catch((err) => {
  logger.error(err, "test-ai-compare failed");
  process.exit(1);
});
