/**
 * בדיקה חיה מול מודל אמיתי (Anthropic, tier smart) — יצירת שלב חדש בפרויקט (create_project_stage)
 * מול משימה רגילה (create_task), כולל שיחה רב-שלבית. **בטוחה במפורש**: לא משתמשת ב-runOpsChat/
 * createProjectStageAction/createTaskAction בכלל — מריצה runAgentLoop ישירות מול ה-system prompt
 * וה-schema האמיתיים (systemPrompt/CREATE_TASK_TOOL_DECL/CREATE_PROJECT_STAGE_TOOL_DECL, מיוצאים
 * מ-chat.ts), עם executeToolCall מזויף שאף פעם לא נוגע ב-Monday. מותר להריץ לפני אישור deploy.
 *
 * רקע (2026-09-22, פער production): "תוסיף את המשימה בתור עוד שלב" לא היה נתמך — create_task
 * יודע רק ליצור task/subitem *תחת* שלב קיים, לא ליצור שלב חדש. נוסף create_project_stage.
 * הבדיקות כאן מוודאות:
 *   - בקשה מפורשת ל"שלב" → create_project_stage, לא create_task.
 *   - בקשה עמומה (לא ברור משימה/שלב) → לא קורא לאף כלי, שואל.
 *   - שיחה רב-שלבית: פרויקט + תוכן נשמרים ב-context; "תוסיף את זה בתור עוד שלב" בסוף השיחה
 *     גובר על ניסוח קודם שנשמע כמו משימה — create_project_stage עם ה-context שנצבר, לא create_task.
 *
 * ר' test-project-stage.ts לבדיקה דטרמיניסטית (בלי AI) של matchProjectsByQuery/הרשאות/scope.
 *
 *   npm run test:project-stage-behavior
 */

import "dotenv/config";
import { runAgentLoop } from "../src/ai/agentLoop.js";
import { aiConfig } from "../src/ai/tierConfig.js";
import type { NormTool, NormToolCall } from "../src/ai/providers/types.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { CREATE_PROJECT_STAGE_TOOL_DECL, CREATE_TASK_TOOL_DECL, systemPrompt } from "../src/ops/chat.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
}

const FAKE_STAGES = ["שלב 1 - תכנון", "שלב 2 - היתר", "שלב 3 - היתר בניה"];

/** stub נאמן ל-createTaskAction האמיתית — אותה לוגיקה כמו test-create-task-behavior.ts. */
function stubCreateTaskExecute(input: Record<string, unknown>): { content: string; sideEffect: boolean } {
  const project = input.project ? String(input.project) : "";
  const stage = input.stage ? String(input.stage) : "";
  const taskKind = typeof input.taskKind === "string" ? input.taskKind : undefined;

  if (!project && (taskKind === "project" || taskKind === "stage")) {
    return {
      content: `שגיאה: ניתן taskKind='${taskKind}' בלי project באותה קריאה.`,
      sideEffect: false,
    };
  }
  if (project && !stage) {
    if (taskKind === "stage") {
      return {
        content: `שגיאה: באיזה שלב בפרויקט "${project}" תרצה להוסיף את המשימה? השלבים הקיימים: ${FAKE_STAGES.join(", ")}`,
        sideEffect: false,
      };
    }
    if (taskKind !== "project") {
      return {
        content: `שגיאה: המשימה קשורה לפרויקט "${project}" — האם לקשר אותה לפרויקט (בלוח המשימות, בלי שלב), או ליצור אותה תחת אחד משלבי הפרויקט?`,
        sideEffect: false,
      };
    }
  }
  return {
    content: JSON.stringify({ ok: true, itemName: String(input.taskName ?? "stub"), source: stage ? "project_stage" : "general", project }),
    sideEffect: true,
  };
}

/** stub נאמן ל-createProjectStageAction — מדמה הצלחה (החיפוש/הרשאות עצמם נבדקים ב-test-project-stage.ts). */
function stubCreateProjectStageExecute(input: Record<string, unknown>): { content: string; sideEffect: boolean } {
  const project = input.project ? String(input.project) : "";
  const name = input.name ? String(input.name) : "";
  if (!project || !name) {
    return { content: "שגיאה: חסר project או name.", sideEffect: false };
  }
  return {
    content: JSON.stringify({ ok: true, itemName: name, project }),
    sideEffect: true,
  };
}

function toolsFor(): NormTool[] {
  return [
    { name: CREATE_TASK_TOOL_DECL.name, description: CREATE_TASK_TOOL_DECL.description, parameters: CREATE_TASK_TOOL_DECL.input_schema },
    { name: CREATE_PROJECT_STAGE_TOOL_DECL.name, description: CREATE_PROJECT_STAGE_TOOL_DECL.description, parameters: CREATE_PROJECT_STAGE_TOOL_DECL.input_schema },
  ];
}

function execute(call: NormToolCall): { content: string; sideEffect: boolean } {
  const input = call.input as Record<string, unknown>;
  if (call.name === "create_project_stage") return stubCreateProjectStageExecute(input);
  return stubCreateTaskExecute(input);
}

async function runScenario(message: string, userKey = "dov") {
  const user = resolveUserByKey(userKey)!;
  const calls: NormToolCall[] = [];
  const result = await runAgentLoop({
    provider: aiConfig.smart.provider,
    model: aiConfig.smart.model,
    system: systemPrompt(user),
    maxTokens: 1024,
    maxTurns: 3,
    messages: [{ role: "user", content: message }],
    tools: toolsFor(),
    executeToolCall: async (call) => {
      calls.push(call);
      return execute(call);
    },
  });
  return { calls, text: result.text, errored: result.errored };
}

interface ConvTurn {
  role: "user" | "assistant";
  content: string;
}

async function runConversation(userTurns: string[], userKey = "dov") {
  const user = resolveUserByKey(userKey)!;
  const messages: ConvTurn[] = [];
  const perTurnCalls: NormToolCall[][] = [];

  for (const userMsg of userTurns) {
    messages.push({ role: "user", content: userMsg });
    const calls: NormToolCall[] = [];
    const result = await runAgentLoop({
      provider: aiConfig.smart.provider,
      model: aiConfig.smart.model,
      system: systemPrompt(user),
      maxTokens: 1024,
      maxTurns: 4,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: toolsFor(),
      executeToolCall: async (call) => {
        calls.push(call);
        return execute(call);
      },
    });
    perTurnCalls.push(calls);
    messages.push({ role: "assistant", content: result.text ?? "" });
  }

  return { perTurnCalls, messages };
}

async function main() {
  logger.info("── תרחיש 1: 'תוסיף בפרויקט תכנית פרסום ושיווק גוטליב אדריכלים שלב חדש בשם סוכות' — create_project_stage, לא create_task ──");
  {
    const { calls, errored } = await runScenario(
      "תוסיף בפרויקט תכנית פרסום ושיווק גוטליב אדריכלים שלב חדש בשם סוכות",
    );
    const stageCalls = calls.filter((c) => c.name === "create_project_stage");
    const taskCalls = calls.filter((c) => c.name === "create_task");
    check("המודל קרא ל-create_project_stage (לא create_task)", stageCalls.length === 1 && taskCalls.length === 0, JSON.stringify(calls));
    if (stageCalls.length === 1) {
      const input = stageCalls[0]!.input as Record<string, unknown>;
      check("project הועבר וכולל 'גוטליב'", String(input.project ?? "").includes("גוטליב"), JSON.stringify(input));
      check("name הועבר וכולל 'סוכות'", String(input.name ?? "").includes("סוכות"), JSON.stringify(input));
    }
    check("לא הייתה שגיאת מודל", !errored);
  }

  logger.info("\n── תרחיש 2: 'תוסיף תחת גוטליב שלב חדש בשם סוכות' — שם פרויקט חלקי, עדיין create_project_stage ──");
  {
    const { calls, errored } = await runScenario("תוסיף תחת גוטליב שלב חדש בשם סוכות");
    const stageCalls = calls.filter((c) => c.name === "create_project_stage");
    check("המודל קרא ל-create_project_stage עם שם פרויקט חלקי ('גוטליב')", stageCalls.length === 1, JSON.stringify(calls));
    if (stageCalls.length === 1) {
      const input = stageCalls[0]!.input as Record<string, unknown>;
      check("project מכיל 'גוטליב'", String(input.project ?? "").includes("גוטליב"), JSON.stringify(input));
    }
    check("לא הייתה שגיאת מודל", !errored);
  }

  logger.info("\n── תרחיש 3: 'תוסיף תחת גוטליב משהו בשם סוכות' — לא ברור משימה/שלב, שואל ולא יוצר כלום ──");
  {
    const { calls, text, errored } = await runScenario("תוסיף תחת גוטליב משהו בשם סוכות");
    check("המודל לא קרא לאף כלי (לא ברור אם משימה או שלב)", calls.length === 0, JSON.stringify(calls));
    check("המודל שואל משימה/שלב", !!text && /משימה|שלב/.test(text), text ?? "(ריק)");
    check("לא הייתה שגיאת מודל", !errored);
    logger.info(`תשובת המודל: "${text}"`);
  }

  logger.info(
    "\n── תרחיש 4 (רב-שלבי): 'תיצור לי משהו תחת גוטליב' → 'סוכות מתקרב' → 'תוסיף את זה בתור עוד שלב' — context נשמר, הכוונה האחרונה גוברת ──",
  );
  {
    const { perTurnCalls, messages } = await runConversation([
      "תיצור לי משהו תחת גוטליב",
      "סוכות מתקרב",
      "תוסיף את זה בתור עוד שלב",
    ]);

    // סבב 1 ("תחת גוטליב", בלי תוכן) — אסור לקרוא לכלי, אין עדיין taskName/name.
    check("סבב 1: לא נוצר כלום עדיין (אין עדיין תוכן)", perTurnCalls[0]!.length === 0, JSON.stringify(perTurnCalls[0]));
    // סבב 2 ("סוכות מתקרב") — "תחת" בסבב 1 כבר מסמן היררכיה (ר' create_task: 'תחת' תמיד stage),
    // אז קריאה ל-create_task עם taskKind='stage' (שמחזירה "באיזה שלב?") תקינה כאן בדיוק כמו שאלה
    // ישירה — שתיהן משאירות את ההחלטה הסופית (שלב קיים מול שלב *חדש*) לסבב 3. לא בודקים איזו
    // משתי הדרכים נבחרה, רק שאף אחת מהן לא *יצרה* שלב/משימה בפועל (sideEffect) לפני שהמשתמש
    // הבהיר "בתור עוד שלב" בסבב 3.
    const turn2CreatedAnything = perTurnCalls[1]!.some((c) => c.name === "create_project_stage");
    check(
      "סבב 2: לא נוצר שלב בפועל לפני שהמשתמש אמר 'בתור עוד שלב' (create_task עם taskKind='stage' כדי לשאול איזה שלב — תקין; create_project_stage בשלב הזה — לא)",
      !turn2CreatedAnything,
      JSON.stringify(perTurnCalls[1]),
    );

    const turn3Stage = perTurnCalls[2]!.filter((c) => c.name === "create_project_stage");
    const turn3Task = perTurnCalls[2]!.filter((c) => c.name === "create_task");
    check(
      "**קריטי**: סבב 3 ('תוסיף את זה בתור עוד שלב') → create_project_stage, לא create_task",
      turn3Stage.length === 1 && turn3Task.length === 0,
      JSON.stringify(perTurnCalls[2]),
    );
    if (turn3Stage.length === 1) {
      const input = turn3Stage[0]!.input as Record<string, unknown>;
      check("project נשמר מהקשר קודם (מכיל 'גוטליב')", String(input.project ?? "").includes("גוטליב"), JSON.stringify(input));
      check("name נשמר מהקשר קודם (מכיל 'סוכות')", String(input.name ?? "").includes("סוכות"), JSON.stringify(input));
    }

    logger.info("תמליל מלא:\n" + messages.map((m) => `[${m.role}] ${m.content}`).join("\n"));
  }

  logger.info(
    "\n── תרחיש 5 (שינוי כוונה): 'תוסיף משימה בפרויקט מגדל השרון בשם ריהוט חדש' → 'זה בעצם שלב, לא משימה' — גובר, יוצר שלב ──",
  );
  {
    const { perTurnCalls, messages } = await runConversation([
      "תוסיף משימה בפרויקט מגדל השרון בשם ריהוט חדש",
      "בעצם זה שלב חדש, לא משימה רגילה",
    ]);

    const turn2Stage = perTurnCalls[1]!.filter((c) => c.name === "create_project_stage");
    const turn2Task = perTurnCalls[1]!.filter((c) => c.name === "create_task");
    check(
      "הכוונה האחרונה ('זה שלב, לא משימה') גוברת — create_project_stage, לא create_task",
      turn2Stage.length === 1 && turn2Task.length === 0,
      JSON.stringify(perTurnCalls[1]),
    );
    if (turn2Stage.length === 1) {
      const input = turn2Stage[0]!.input as Record<string, unknown>;
      check("project נשמר ('מגדל השרון')", String(input.project ?? "").includes("מגדל השרון"), JSON.stringify(input));
      check("name נשמר/נגזר מהתוכן הקודם ('ריהוט')", String(input.name ?? "").includes("ריהוט"), JSON.stringify(input));
    }

    logger.info("תמליל מלא:\n" + messages.map((m) => `[${m.role}] ${m.content}`).join("\n"));
  }

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-project-stage-behavior נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
