/**
 * בדיקה חיה מול מודל אמיתי (Anthropic, tier smart) של ההתנהגות בפועל — כולל שיחה רב-שלבית.
 * **בטוחה במפורש**: לא משתמשת ב-runOpsChat/createTaskAction בכלל — מריצה runAgentLoop ישירות
 * מול ה-system prompt וה-schema האמיתיים (systemPrompt/CREATE_TASK_TOOL_DECL, מיוצאים מ-chat.ts
 * כדי שלא נשכפל אותם), עם executeToolCall מזויף שאף פעם לא נוגע ב-Monday — גם אם המודל *בכל
 * זאת* יקרא ל-create_task, התוצאה היא רק רשומה בזיכרון של הבדיקה, לא כתיבה אמיתית. מותר
 * להריץ את זה גם לפני שמאשרים deploy.
 *
 * לתרחישי השיחה הרב-שלבית (3+): ה-stub מדמה את התשובות ה*אמיתיות* של createTaskAction
 * (שאלת כללית/שלב, שגיאת "באיזה שלב" עם רשימה) — כדי שהמודל יקבל בדיוק את המשוב שהוא היה
 * מקבל במערכת האמיתית, ונבדוק אם הוא שומר context נכון בין סבבים.
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

const FAKE_STAGES = ["שלב 1 - תכנון", "שלב 2 - היתר", "שלב 3 - היתר בניה", "שלב 4 - ביצוע"];

/**
 * מדמה בדיוק את התשובות שהמערכת האמיתית (createTaskAction) הייתה מחזירה — כדי שבדיקת שיחה
 * רב-שלבית תיתן למודל משוב אמיתי, לא stub שקוף שרק בולע קריאות. לא נוגע ב-Monday בפועל.
 */
function stubCreateTaskExecute(input: Record<string, unknown>): { content: string; sideEffect: boolean } {
  const project = input.project ? String(input.project) : "";
  const stage = input.stage ? String(input.stage) : "";
  const taskKind = typeof input.taskKind === "string" ? input.taskKind : undefined;

  if (project && !stage) {
    if (taskKind === "stage") {
      return {
        content: `שגיאה: באיזה שלב בפרויקט "${project}" תרצה להוסיף את המשימה? השלבים הקיימים: ${FAKE_STAGES.join(", ")}`,
        sideEffect: false,
      };
    }
    if (taskKind !== "general") {
      return {
        content: `שגיאה: להוסיף את המשימה בפרויקט "${project}" כמשימה כללית המקושרת לפרויקט, או תחת אחד משלבי הפרויקט?`,
        sideEffect: false,
      };
    }
  }
  return {
    content: JSON.stringify({ ok: true, itemName: String(input.taskName ?? "stub"), source: stage ? "project_stage" : "general" }),
    sideEffect: true,
  };
}

interface ConvTurn {
  role: "user" | "assistant";
  content: string;
}

/** מריץ שיחה רב-שלבית אמיתית: כל סבב = קריאת runAgentLoop נפרדת עם ה-history שנצבר, בדיוק כמו runOpsChat. */
async function runConversation(userTurns: string[]) {
  const moti = resolveUserByKey("moti")!; // owner — canCreateTask + task:manage (יכול להקצות לאחרים)
  const tools: NormTool[] = [
    { name: CREATE_TASK_TOOL_DECL.name, description: CREATE_TASK_TOOL_DECL.description, parameters: CREATE_TASK_TOOL_DECL.input_schema },
  ];
  const messages: ConvTurn[] = [];
  const perTurnCalls: NormToolCall[][] = [];

  for (const userMsg of userTurns) {
    messages.push({ role: "user", content: userMsg });
    const calls: NormToolCall[] = [];
    const result = await runAgentLoop({
      provider: aiConfig.smart.provider,
      model: aiConfig.smart.model,
      system: systemPrompt(moti),
      maxTokens: 1024,
      maxTurns: 4,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools,
      executeToolCall: async (call) => {
        calls.push(call);
        return stubCreateTaskExecute(call.input as Record<string, unknown>);
      },
    });
    perTurnCalls.push(calls.filter((c) => c.name === "create_task"));
    messages.push({ role: "assistant", content: result.text ?? "" });
  }

  return { perTurnCalls, messages };
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

  logger.info("\n── תרחיש 3: 'תוסיף משימה בפרויקט מגדל השרון לעדכן תוכניות' (בלי לציין כללית/שלב) — שואל, לא קורא לכלי ──");
  {
    const { calls, text, errored } = await runScenario("תוסיף משימה בפרויקט מגדל השרון לעדכן תוכניות");
    check("המודל לא קרא ל-create_task (חסר כללית/שלב)", calls.length === 0, `קריאות בפועל: ${JSON.stringify(calls)}`);
    check("לא הייתה שגיאת מודל", !errored);
    check(
      "המודל שואל כללית/תחת שלב (לא בוחר לבד)",
      !!text && /כלל|שלב/.test(text),
      text ?? "(ריק)",
    );
    logger.info(`תשובת המודל: "${text}"`);
  }

  logger.info("\n── תרחיש 4: 'תיצור משימה כללית בפרויקט מגדל השרון לעדכן תוכניות' — קורא ישר עם taskKind='general', בלי שאלה ──");
  {
    const { calls, errored } = await runScenario("תיצור משימה כללית בפרויקט מגדל השרון לעדכן תוכניות");
    check("המודל קרא ל-create_task ישירות (ניסוח 'כללית' מפורש)", calls.length === 1, `קריאות בפועל: ${JSON.stringify(calls)}`);
    if (calls.length === 1) {
      const input = calls[0]!.input as Record<string, unknown>;
      check("taskKind='general'", input.taskKind === "general", `בפועל: ${JSON.stringify(input.taskKind)}`);
      check("project הועבר", !!input.project);
    }
    check("לא הייתה שגיאת מודל", !errored);
  }

  logger.info("\n── תרחיש 5: 'תוסיף משימה בשלב 3 בפרויקט מגדל השרון לעדכן תוכניות' — שלב מפורש, בלי שאלה ──");
  {
    const { calls, errored } = await runScenario("תוסיף משימה בשלב 3 בפרויקט מגדל השרון לעדכן תוכניות");
    check("המודל קרא ל-create_task ישירות (שלב מפורש)", calls.length === 1, `קריאות בפועל: ${JSON.stringify(calls)}`);
    if (calls.length === 1) {
      const input = calls[0]!.input as Record<string, unknown>;
      check("stage הועבר ומכיל את המספר שצוין", String(input.stage ?? "").includes("3"), `בפועל: ${JSON.stringify(input.stage)}`);
    }
    check("לא הייתה שגיאת מודל", !errored);
  }

  logger.info(
    "\n── תרחיש 6 (רב-שלבי): 'תוסיף לדוב משימה בפרויקט X' → 'להכין תכנית חשמל' → 'תחת שלב' → 'שלב 4' — context נשמר לאורך כל השיחה ──",
  );
  {
    const { perTurnCalls, messages } = await runConversation([
      "תוסיף לדוב משימה בפרויקט מגדל השרון",
      "להכין תכנית חשמל",
      "תחת שלב",
      "שלב 4",
    ]);

    check("סבב 1 (רק פרויקט+מבצע, בלי תוכן משימה): לא קרא לכלי", perTurnCalls[0]!.length === 0);
    check(
      // סעיף 8: מותר לשאול גם על taskName וגם על כללית/שלב בבת אחת אם שניהם חסרים — לכן לא
      // דורשים ניסוח ספציפי, רק שהשאלה על תוכן המשימה בהכרח שם (עם "המשימה" ומילת שאלה).
      "סבב 1: המודל שואל על תוכן המשימה (לבד או ביחד עם שאלת כללית/שלב — שניהם תקינים לפי סעיף 8)",
      messages[1]!.content.includes("המשימה") && /מה|איזה/.test(messages[1]!.content),
      messages[1]!.content,
    );

    check("סבב 2 (יש תוכן משימה, אין כללית/שלב): לא קרא לכלי", perTurnCalls[1]!.length === 0);
    check(
      "סבב 2: המודל שואל כללית/תחת שלב, ולא שואל שוב מה הפרויקט/מי המבצע (context נשמר)",
      /כלל|שלב/.test(messages[3]!.content) && !/איזה פרויקט|מי (ה)?מבצע|למי/.test(messages[3]!.content),
      messages[3]!.content,
    );

    check(
      "סבב 3 ('תחת שלב' בלי לנקוב): קרא לכלי עם taskKind='stage' בלי stage (מקבל רשימה אמיתית)",
      perTurnCalls[2]!.length === 1 &&
        (perTurnCalls[2]![0]!.input as Record<string, unknown>).taskKind === "stage" &&
        !(perTurnCalls[2]![0]!.input as Record<string, unknown>).stage,
      JSON.stringify(perTurnCalls[2]),
    );
    check(
      // המודל לפעמים משמיט את קידומת "שלב N - " ומציג רק את התיאור — עדיין דאטה אמיתי מה-stub,
      // לא המצאה, כל עוד השמות עצמם (לא המספרים) מגיעים משם. בודקים לפי שם השלב בלי הקידומת.
      "סבב 3: המודל מציג את השלבים האמיתיים מה-stub (לא ממציא שמות שלבים)",
      FAKE_STAGES.some((s) => messages[5]!.content.includes(s.replace(/^שלב \d+ - /, ""))),
      messages[5]!.content,
    );

    check("סבב 4 ('שלב 4'): קרא לכלי בדיוק פעם אחת, עם כל הפרטים שנצברו", perTurnCalls[3]!.length === 1, JSON.stringify(perTurnCalls[3]));
    if (perTurnCalls[3]!.length === 1) {
      const input = perTurnCalls[3]![0]!.input as Record<string, unknown>;
      check("סבב 4: taskName נשמר מסבב 2 ('להכין תכנית חשמל')", String(input.taskName ?? "").includes("חשמל"), JSON.stringify(input));
      check("סבב 4: project נשמר מסבב 1 ('מגדל השרון')", String(input.project ?? "").includes("מגדל השרון"), JSON.stringify(input));
      check("סבב 4: assignee נשמר מסבב 1 ('דוב')", /דוב/.test(String(input.assignee ?? "")), JSON.stringify(input));
      check("סבב 4: stage הוא '4' לפי התשובה בסבב הזה", String(input.stage ?? "").includes("4"), JSON.stringify(input));
    }

    logger.info("תמליל מלא:\n" + messages.map((m) => `[${m.role}] ${m.content}`).join("\n"));
  }

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-create-task-behavior נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
