/**
 * בדיקה דטרמיניסטית (בלי AI, בלי Monday) שההוראות הבאות באמת נמצאות בטקסט שהמודל מקבל — גם
 * ב-system prompt וגם ב-schema של create_task עצמו. ר' test-create-task-behavior.ts לבדיקה
 * חיה מול מודל אמיתי (multi-turn, מדמה בפועל את התרחישים).
 *
 * רקע 1 (2026-09-22): "תיצור לרוחי משימה" בלי המשך גרם למודל למלא taskName="משימה חדשה" — לא
 * ברירת מחדל בקוד, אלא המצאה של המודל כי ה-prompt הישן עודד "תמיד תקרא לכלי, מלא ברירות מחדל
 * למה שחסר" בלי לחריג את taskName (שאין לו ברירת מחדל הגיונית).
 *
 * רקע 2 (2026-09-24א): "תוסיף משימה לפרויקט X" (בלי לציין תחת-הפרויקט/תחת-שלב) גרם למודל
 * להחליט לבד וליצור subitem בשלב הפעיל (findActiveStage) — התנהגות עסקית לא רצויה. עכשיו:
 * פרויקט לבדו לא מספיק כדי לבחור stage-task; המודל חייב לשאול.
 *
 * רקע 3 (2026-09-24ב, אחרי אירוע production אמיתי — item "להתקשר ליוכי" נוצר בלי קישור
 * לפרויקט): המודל שאל "כללית או תחת שלב" (הניסוח הישן), המשתמש בחר "כללית", והתשובה הסופית
 * טענה שהמשימה נוצרה "בפרויקט X" — אבל בפועל board_relation_mkqzzfgt נשאר ריק. שני תיקונים:
 * (א) מודל עסקי מדויק יותר — "תחת הפרויקט" (לא "כללית", מונח שמטשטש בין בלי-פרויקט לבין
 * עם-קישור-לפרויקט) מול "תחת שלב"; (ב) createGeneralTask תוקנה לכתוב את הקישור ב-
 * change_column_value נפרד אחרי היצירה, כי create_item התברר כלא כותב עמודות connect_boards
 * inline (ר' opsWrite.ts) — person/status כן נכתבו נכון מאותו column_values, רק הקישור לא.
 *
 *   npm run test:create-task-prompt
 */

import "dotenv/config";
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

function main() {
  const dov = resolveUserByKey("dov")!; // project_manager — יש לו canCreateTask

  const prompt = systemPrompt(dov);
  check(
    "system prompt מנחה במפורש שאסור ליצור לפני ששני הדברים הובהרו (taskName + סוג)",
    prompt.includes("אסור ליצור לפני ששניהם הובהרו"),
  );
  check("system prompt נותן דוגמה לשאלה המבהירה תוכן משימה חסר", prompt.includes("מה המשימה שתרצה לפתוח"));
  check("system prompt אוסר placeholder 'משימה חדשה'", prompt.includes("משימה חדשה"));
  check("system prompt אוסר placeholder 'ללא שם'", prompt.includes("ללא שם"));
  check(
    "system prompt מבהיר ש-taskName הוא תוכן בפועל ('להתקשר ליוסי') לא כותרת נפרדת",
    prompt.includes("להתקשר ליוסי"),
  );

  // רקע 3: המודל העסקי המדויק (general / project / stage) — לא "כללית" עם פרויקט
  check(
    "system prompt מגדיר את שלושת הסוגים במפורש (בלי פרויקט / תחת הפרויקט / תחת שלב)",
    prompt.includes("שלושה סוגי משימה"),
  );
  check(
    "system prompt אוסר במפורש את המונח 'כללית' לתיאור משימה-עם-קישור-לפרויקט",
    prompt.includes("אל תשתמש במילה 'כללית' לתיאור (2)"),
  );
  check(
    "system prompt אוסר על המודל לבחור לבד בין תחת-הפרויקט לתחת-שלב",
    prompt.includes("החלטה עסקית של המשתמש, אסור לך לבחור לבד"),
  );
  check(
    "system prompt נותן את נוסח השאלה המדויק (תחת הפרויקט או תחת שלב, לא 'כללית')",
    prompt.includes("האם להוסיף את המשימה תחת הפרויקט, או תחת אחד משלבי הפרויקט?"),
  );
  check(
    "system prompt מבהיר ששלב מפורש מכריע לבד, בלי שאלה",
    prompt.includes("שלב מפורש") && prompt.includes("מכריע לבד"),
  );
  check(
    "system prompt מבהיר ש'תחת הפרויקט' מפורש מכריע לבד → taskKind='project'",
    prompt.includes("תעביר taskKind='project' ואל תשאל כלום"),
  );
  check(
    "system prompt מנחה איך להתמודד עם 'תחת שלב' בלי שם שלב (לקרוא עם taskKind='stage', להציג רשימה אמיתית)",
    prompt.includes("הכלי יחזיר שגיאה עם רשימת השלבים האמיתיים"),
  );
  check(
    // רקע 3: התיקון הקריטי — project חייב לחזור בכל קריאה, לא רק בפעם הראשונה.
    "system prompt מדגיש שחובה להעביר project מחדש בכל קריאה חוזרת, לא רק פעם ראשונה",
    prompt.includes("project הוא לא 'פעם אחת וזהו'") && prompt.includes("גם אם כבר הועברו בקריאה קודמת"),
  );
  check("system prompt מנחה לשמור context בין הודעות", prompt.includes("שמור context בין הודעות") || prompt.includes("שמור context כדי לדעת"));
  check(
    "system prompt כבר לא מכיל את ההתנהגות הישנה (בחירת שלב פעיל אוטומטית)",
    !prompt.includes("המשימה תיווצר בשלב הנכון אוטומטית"),
  );

  const taskNameDesc = CREATE_TASK_TOOL_DECL.input_schema.properties.taskName.description;
  check("תיאור taskName ב-schema אוסר המצאת ערך/placeholder", /placeholder|מומצא/.test(taskNameDesc));
  check("תיאור taskName ב-schema מנחה לשאול לפני קריאה לכלי", taskNameDesc.includes("שאל"));
  check("taskName עדיין required ב-schema (הבעיה היא מתי לקרוא לכלי, לא הסכמה עצמה)", CREATE_TASK_TOOL_DECL.input_schema.required.includes("taskName"));

  const projectDesc = CREATE_TASK_TOOL_DECL.input_schema.properties.project.description;
  check(
    "תיאור project ב-schema מדגיש שצריך להעביר אותו שוב בכל קריאה עוקבת",
    projectDesc.includes("בכל קריאה עוקבת"),
  );

  const taskKindDesc = CREATE_TASK_TOOL_DECL.input_schema.properties.taskKind.description;
  check(
    "taskKind ב-schema הוא enum project/stage (לא 'general')",
    JSON.stringify(CREATE_TASK_TOOL_DECL.input_schema.properties.taskKind.enum) === '["project","stage"]',
  );
  check("תיאור taskKind אוסר על המודל למלא אותו לבד", taskKindDesc.includes("אל תמלא לבד"));
  check("תיאור taskKind אוסר במפורש את המונח 'כללית'", taskKindDesc.includes("'כללית'"));
  check("taskKind לא required (כי stage מפורש יכול להחליף אותו)", !CREATE_TASK_TOOL_DECL.input_schema.required.includes("taskKind"));

  // ולידציה שהמשתמשים בלי הרשאת יצירה לא רואים את ההוראה הזו בכלל (התנאי הקיים canCreateTask)
  const goldi = resolveUserByKey("goldi")!; // finance — אין לו task:create/task:manage
  const goldiPrompt = systemPrompt(goldi);
  check("משתמש בלי הרשאת יצירה לא רואה את הוראת create_task בכלל", !goldiPrompt.includes("create_task"));

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main();
