/**
 * בדיקה חיה מול מודל אמיתי (Anthropic, tier smart) של ההתנהגות בפועל: "תיצור לרוחי משימה"
 * בלי תוכן משימה. **בטוחה במפורש**: לא משתמשת ב-runOpsChat/createTaskAction בכלל — מריצה
 * runAgentLoop ישירות מול ה-system prompt וה-schema האמיתיים (systemPrompt/CREATE_TASK_TOOL_DECL,
 * מיוצאים מ-chat.ts כדי שלא נשכפל אותם), עם executeToolCall מזויף שאף פעם לא נוגע ב-Monday —
 * גם אם המודל *בכל זאת* יקרא ל-create_task (למשל אם הבדיקה הזו עצמה חושפת כשל בתיקון), התוצאה
 * היא רק רשומה בזיכרון של הבדיקה, לא כתיבה אמיתית. לכן מותר להריץ את זה גם לפני שמאשרים deploy.
 *
 * הרצת מודל אמיתית → תוצאה לא ב-100% דטרמיניסטית (אופי LLM). ר' test-create-task-prompt.ts
 * לבדיקה דטרמיניסטית על טקסט ה-prompt/schema עצמם.
 *
 *   npm run test:create-task-behavior
 */

import "dotenv/config";
import { runAgentLoop } from "../src/ai/agentLoop.js";
import { aiConfig } from "../src/ai/tierConfig.js";
import type { NormTool, NormToolCall } from "../src/ai/providers/types.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { CREATE_TASK_TOOL_DECL, systemPrompt } from "../src/ops/chat.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
}

const PLACEHOLDERS = ["משימה חדשה", "משימה", "ללא שם", "משימה כללית"];

async function runScenario(message: string) {
  const dov = resolveUserByKey("dov")!;
  const tools: NormTool[] = [
    { name: CREATE_TASK_TOOL_DECL.name, description: CREATE_TASK_TOOL_DECL.description, parameters: CREATE_TASK_TOOL_DECL.input_schema },
  ];
  const calls: NormToolCall[] = [];

  const result = await runAgentLoop({
    provider: aiConfig.smart.provider,
    model: aiConfig.smart.model,
    system: systemPrompt(dov),
    maxTokens: 1024,
    maxTurns: 3,
    messages: [{ role: "user", content: message }],
    tools,
    // stub בטוח לגמרי — אף קריאה לא מגיעה ל-createTaskAction/Monday, לא משנה מה המודל יעשה.
    executeToolCall: async (call) => {
      calls.push(call);
      return { content: JSON.stringify({ ok: true, itemName: "(stub — לא נוצר באמת)" }), sideEffect: false };
    },
  });

  return { calls: calls.filter((c) => c.name === "create_task"), text: result.text, errored: result.errored };
}

async function main() {
  logger.info("── תרחיש 1: 'תיצור לרוחי משימה' (בלי תוכן) — לא אמור לקרוא לכלי ──");
  {
    const { calls, text, errored } = await runScenario("תיצור לרוחי משימה");
    check("המודל לא קרא ל-create_task בכלל", calls.length === 0, `קריאות בפועל: ${JSON.stringify(calls)}`);
    if (calls.length > 0) {
      const taskName = String((calls[0]!.input as Record<string, unknown>)?.taskName ?? "");
      check("אם בכל זאת נקרא — לפחות לא עם placeholder ידוע", !PLACEHOLDERS.includes(taskName), `taskName: "${taskName}"`);
    }
    check("לא הייתה שגיאת מודל", !errored);
    check("המודל החזיר טקסט (שאלה מבהירה, לא שתיקה)", !!text && text.trim().length > 0, text ?? "(ריק)");
    logger.info(`תשובת המודל: "${text}"`);
  }

  logger.info("\n── תרחיש 2: 'תיצור לרוחי משימה להתקשר ליוסי' — כן אמור לקרוא, עם taskName='להתקשר ליוסי' ──");
  {
    const { calls, errored } = await runScenario("תיצור לרוחי משימה להתקשר ליוסי");
    check("המודל כן קרא ל-create_task כשיש תוכן", calls.length === 1, `קריאות בפועל: ${JSON.stringify(calls)}`);
    if (calls.length === 1) {
      const taskName = String((calls[0]!.input as Record<string, unknown>)?.taskName ?? "");
      check(
        "taskName הוא התוכן שנאמר ('להתקשר ליוסי'), לא placeholder ולא ריק",
        taskName.includes("יוסי") && !PLACEHOLDERS.includes(taskName),
        `taskName בפועל: "${taskName}"`,
      );
    }
    check("לא הייתה שגיאת מודל", !errored);
  }

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-create-task-behavior נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
