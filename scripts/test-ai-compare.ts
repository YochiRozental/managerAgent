/**
 * השוואת ספקים/מודלים — מריץ *אותה* בקשה מול שתי תצורות ומדפיס זמן/טוקנים/עלות/tool-calls/הצלחה.
 *
 * ⚠️  READ ONLY בכל מצב. אין כאן שום כלי כתיבה/שינוי — לא יוצר משימות, לא שולח מייל, לא נוגע ביומן,
 *     לא משנה כלום ב-Monday. גם אם המודל יבקש כלי כתיבה — הוא לא קיים ברישום ולכן נחסם.
 *
 * כלים (--tools):
 *   (ללא --tools)      → בלי כלים בכלל, טקסט בלבד.
 *   --tools monday     → רק כלי קריאה של Monday. **Google לא נטען כלל** (import דינמי מותנה) — אין OAuth.
 *   --tools google     → רק כלי קריאה של Google (list_calendar_events). עלול להפעיל Google OAuth בפעם הראשונה.
 *   --tools all        → Monday + Google (התנהגות --tools הישנה).
 *   --tools (בלי ערך)  → כמו all (תאימות לאחור).
 *
 * שימוש:
 *   npm run test:ai-compare -- --help
 *   npm run test:ai-compare
 *   npm run test:ai-compare -- --a anthropic:claude-haiku-4-5-20251001 --b openai:gpt-5.4-mini --tools monday
 *   npm run test:ai-compare -- --prompt "נסח סיכום קצר של מצב פרויקט תקוע"
 *
 * הפלט לכל מודל: provider/model · זמן · input/output tokens · עלות משוערת · מספר tool calls,
 * ובנוסף — פירוט כל tool call (שם, הפרמטרים שהמודל שלח, הצלחה + כמה פריטים חזרו),
 * ובסוף **התשובה המלאה של המודל בלי שום קיצור**.
 * תוצאות הכלים עצמן (תוכן הפריטים מ-Monday) **אינן מודפסות** — רק המודל מקבל אותן, כדי שההשוואה
 * תהיה אמיתית וכדי לא ליצור לוג ענק / לחשוף מידע מיותר.
 *
 * דורש ANTHROPIC_API_KEY / OPENAI_API_KEY לפי הספקים שנבחרו.
 * הערה: gpt-5.4-mini הוא reasoning model — תקציב ה-output כאן גדול (2000) כדי שההשוואה תהיה הוגנת
 * (טוקני reasoning נספרים ב-output).
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { runAgentLoop } from "../src/ai/agentLoop.js";
import { estimateCostUsd } from "../src/ai/pricing.js";
import { aiConfig } from "../src/ai/tierConfig.js";
import { isProviderName, type NormTool, type NormToolCall, type ProviderName } from "../src/ai/providers/types.js";
import { logger } from "../src/utils/logger.js";

type ToolScope = "none" | "monday" | "google" | "all";

const USAGE = `test:ai-compare — השוואת ספק/מודל, READ ONLY בלבד.

  npm run test:ai-compare -- [אפשרויות]

אפשרויות:
  --a <provider:model>   תצורה A (ברירת מחדל: ה-tier FAST הנוכחי — ${aiConfig.fast.provider}:${aiConfig.fast.model})
  --b <provider:model>   תצורה B (ברירת מחדל: ה-tier SMART הנוכחי — ${aiConfig.smart.provider}:${aiConfig.smart.model})
                         provider תקף: anthropic | openai
  --prompt "<טקסט>"      הבקשה לשליחה לשני המודלים
  --tools [monday|google|all]
                         אילו כלי קריאה לחשוף. ללא הדגל — בלי כלים.
                         --tools בלי ערך = all (תאימות לאחור).
                         monday: Google לא נטען כלל, אין OAuth.
  --turns <N>            מקסימום סבבי tool-use (ברירת מחדל 4)
  --max-tokens <N>       תקציב output לכל קריאה (ברירת מחדל 2000)
  --list-tools           הצגת הכלים ש-scope נתון חושף ויציאה (בלי מודלים, בלי API)
  --help, -h             הצגת עזרה זו ויציאה (בלי להריץ מודלים, בלי לצרוך API)

הפלט לכל מודל:
  • provider/model · זמן תגובה · input/output tokens · עלות משוערת · מספר tool calls
  • פירוט כל tool call: מספר סידורי, שם הכלי, הפרמטרים שהמודל שלח, הצלחה/כשל + מספר פריטים שחזרו
  • התשובה המלאה של המודל — ללא קיצור וללא "..."
תוצאות הכלים עצמן (תוכן הפריטים) לא מודפסות — רק המודל מקבל אותן.
אף מצב לא מריץ כלי כתיבה/שינוי. הכל read-only.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveToolScope(): ToolScope {
  const i = process.argv.indexOf("--tools");
  if (i === -1) return "none";
  const next = process.argv[i + 1];
  if (!next || next.startsWith("-")) return "all"; // --tools בלי ערך → תאימות לאחור
  const v = next.toLowerCase();
  if (v === "monday" || v === "google" || v === "all") return v;
  throw new Error(`--tools ערך לא תקין: "${next}". תקפים: monday | google | all (או --tools בלי ערך = all)`);
}

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

interface ReadTool {
  spec: NormTool;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

/** נדלק רק אם באמת נעשה import דינמי למודול Google — לשקיפות ב---list-tools. */
let googleModuleImported = false;

/**
 * בדיקת אמת: האם חבילת `googleapis` (CJS) נטענה בפועל ל-require cache.
 * היא נכנסת רק אם משהו ייבא את src/integrations/google/* — כלומר עדות ש-Google *לא* נגעה.
 */
const req = createRequire(import.meta.url);
function isGoogleapisLoaded(): boolean {
  try {
    return !!req.cache[req.resolve("googleapis")];
  } catch {
    return false;
  }
}

/**
 * בונה את רישום כלי הקריאה לפי ה-scope. **imports דינמיים מותנים** — כך ש-`monday`
 * לא טוען את מודולי Google בכלל (אין `googleapis`, אין `auth.ts`, אין OAuth).
 * הרישום מכיל אך ורק פונקציות קריאה.
 */
async function loadReadTools(scope: ToolScope): Promise<Map<string, ReadTool>> {
  const reg = new Map<string, ReadTool>();
  if (scope === "none") return reg;

  if (scope === "monday" || scope === "all") {
    const { listBoards, findBoardsByName, listTasks, listMyWork } = await import("../src/integrations/monday/tasks.js");
    const { findUsersByName } = await import("../src/integrations/monday/users.js");
    reg.set("list_monday_boards", {
      spec: { name: "list_monday_boards", description: "מחזיר את כל הלוחות ב-Monday עם שם ו-id.", parameters: { type: "object", properties: {} } },
      run: () => listBoards(),
    });
    reg.set("find_monday_board", {
      spec: {
        name: "find_monday_board",
        description: "מחפש לוחות ב-Monday לפי מילה בשם.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      run: (i) => findBoardsByName(String(i.query ?? "")),
    });
    reg.set("list_monday_tasks", {
      spec: {
        name: "list_monday_tasks",
        description: "מחזיר את המשימות בלוח מסוים ב-Monday.",
        parameters: { type: "object", properties: { boardId: { type: "string" } }, required: ["boardId"] },
      },
      run: (i) => listTasks(String(i.boardId ?? "")),
    });
    reg.set("list_my_work", {
      spec: { name: "list_my_work", description: "משימות פתוחות של בעל חשבון ה-API (מקביל ל-My Work).", parameters: { type: "object", properties: {} } },
      run: () => listMyWork(),
    });
    reg.set("find_monday_user", {
      spec: {
        name: "find_monday_user",
        description: "מחפש איש/אשת צוות ב-Monday לפי שם.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      run: (i) => findUsersByName(String(i.query ?? "")),
    });
  }

  if (scope === "google" || scope === "all") {
    googleModuleImported = true;
    const { listCalendarEvents } = await import("../src/integrations/google/calendar.js");
    reg.set("list_calendar_events", {
      spec: {
        name: "list_calendar_events",
        description: "מחזיר אירועים ביומן Google בטווח זמן (timeMinISO / timeMaxISO ב-ISO 8601).",
        parameters: {
          type: "object",
          properties: { timeMinISO: { type: "string" }, timeMaxISO: { type: "string" } },
          required: ["timeMinISO", "timeMaxISO"],
        },
      },
      run: (i) => listCalendarEvents({ timeMinISO: String(i.timeMinISO ?? ""), timeMaxISO: String(i.timeMaxISO ?? "") }),
    });
  }

  return reg;
}

interface ToolTraceEntry {
  order: number;
  name: string;
  /** JSON של מה שהמודל שלח לכלי (מקוצר לתצוגה). לא תוכן שחזר מהכלי. */
  params: string;
  ok: boolean;
  /** תקציר טכני בלבד — מספר פריטים / הודעת שגיאה. אף פעם לא תוכן הפריטים. */
  summary: string;
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
  toolTrace: ToolTraceEntry[];
  /** התשובה המלאה של המודל — מוצגת כמו שהיא, בלי קיצור. */
  fullResponse: string;
}

/** תקציר טכני של ערך שחזר מכלי — **מספר בלבד, אף פעם לא התוכן**. */
function describeToolResult(out: unknown): string {
  if (Array.isArray(out)) return `${out.length} פריטים`;
  if (typeof out === "string") return `טקסט · ${out.length} תווים`;
  if (out && typeof out === "object") return `אובייקט · ${Object.keys(out).length} שדות`;
  if (out == null) return "ריק";
  return typeof out;
}

/** JSON של פרמטרי המודל, מקוצר לתצוגה. אלה ערכים שהמודל בחר (query / boardId / טווח זמן) — לא סודות. */
function briefParams(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(input ?? {});
  } catch {
    s = String(input);
  }
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

async function runOne(
  target: { provider: ProviderName; model: string },
  prompt: string,
  reg: Map<string, ReadTool>,
): Promise<RunReport> {
  const normTools: NormTool[] = [...reg.values()].map((t) => t.spec);
  const toolTrace: ToolTraceEntry[] = [];

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
      // רק כלי קריאה מהרישום. כל שם אחר (כולל כלי כתיבה) → נחסם.
      // רושמים כל קריאה ל-toolTrace: שם + פרמטרים + הצלחה + מספר פריטים. לא את התוכן שחזר.
      executeToolCall: async (call: NormToolCall) => {
        const order = toolTrace.length + 1;
        const params = briefParams(call.input);
        const tool = reg.get(call.name);
        if (!tool) {
          toolTrace.push({ order, name: call.name, params, ok: false, summary: "כלי לא זמין — נחסם" });
          return { content: `שגיאה: הכלי ${call.name} אינו זמין בסקריפט ההשוואה (רק כלי קריאה, לפי --tools)`, sideEffect: false };
        }
        try {
          const out = await tool.run((call.input ?? {}) as Record<string, unknown>);
          toolTrace.push({ order, name: call.name, params, ok: true, summary: describeToolResult(out) });
          // התוכן המלא נשלח *למודל בלבד* (נחוץ להשוואה אמיתית) — לא ללוג.
          return { content: JSON.stringify(out), sideEffect: false };
        } catch (err) {
          toolTrace.push({ order, name: call.name, params, ok: false, summary: `שגיאה: ${(err as Error).message}` });
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
      toolTrace,
      fullResponse: res.text ?? "",
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
      toolTrace,
      fullResponse: "",
    };
  }
}

function printReport(label: string, t: { provider: string; model: string }, r: RunReport) {
  logger.info(`\n━━ ${label}: ${t.provider} / ${t.model} ━━`);
  logger.info(`  ${r.ok ? "✓ הצליח" : "✗ נכשל"}${r.error ? ` (${r.error})` : ""}`);
  logger.info(`  ⏱  ${r.ms.toFixed(0)} ms`);
  logger.info(`  🔤 input: ${r.inputTokens}${r.cachedTokens ? ` (מתוכם ${r.cachedTokens} מ-cache)` : ""} · output: ${r.outputTokens}`);
  logger.info(`  💰 עלות משוערת: ${r.cost != null ? `$${r.cost.toFixed(5)}` : "לא ידוע (מודל לא במחירון)"}`);
  logger.info(`  🔧 tool calls: ${r.toolCalls}`);
  for (const e of r.toolTrace) {
    logger.info(`     ${e.order}. ${e.name}  params=${e.params}  → ${e.ok ? "✓" : "✗"} ${e.summary}`);
  }
  const body = r.fullResponse.trim();
  logger.info(`  ─────── תשובה מלאה (${body.length} תווים) ───────`);
  logger.info(body || "(אין תשובה)");
}

const SCOPE_LABEL: Record<ToolScope, string> = {
  none: "ללא כלים (טקסט בלבד)",
  monday: "כלי קריאה של Monday בלבד — Google לא נטען, אין OAuth",
  google: "כלי קריאה של Google בלבד (list_calendar_events)",
  all: "כלי קריאה של Monday + Google",
};

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    logger.info(USAGE);
    return;
  }

  const scope = resolveToolScope();

  if (process.argv.includes("--list-tools")) {
    const reg = await loadReadTools(scope);
    logger.info(`scope: ${scope} — ${SCOPE_LABEL[scope]}`);
    logger.info(`כלים שנחשפים (${reg.size}): ${[...reg.keys()].join(", ") || "—"}`);
    logger.info(`import דינמי ל-Google בוצע: ${googleModuleImported ? "כן" : "לא"}`);
    logger.info(`חבילת googleapis ב-require cache: ${isGoogleapisLoaded() ? "כן" : "לא"}`);
    logger.info("כל הכלים כאן הם קריאה בלבד. לא הורצו מודלים ולא נצרך API.");
    return;
  }

  const prompt =
    arg("prompt") ??
    "יש פרויקט בנייה שתקוע 12 יום כי אין אישור ועדה, ומנהל הפרויקט לא עדכן. נסח בקצרה מה הצעד הבא ואיך להתריע.";
  const a = parseTarget(arg("a"), aiConfig.fast);
  const b = parseTarget(arg("b"), aiConfig.smart);

  logger.info("═══ השוואת AI ═══");
  logger.info(`בקשה: "${prompt}"`);
  logger.info(`כלים: ${SCOPE_LABEL[scope]}`);
  if (a.provider === b.provider && a.model === b.model) {
    logger.warn("שתי התצורות זהות — ההשוואה לא מאוד מעניינת. העבר/י --a ו/או --b.");
  }

  const reg = await loadReadTools(scope);
  const [ra, rb] = await Promise.all([runOne(a, prompt, reg), runOne(b, prompt, reg)]);
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
