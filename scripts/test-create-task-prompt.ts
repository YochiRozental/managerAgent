/**
 * בדיקה דטרמיניסטית (בלי AI, בלי Monday) שההוראות הבאות באמת נמצאות בטקסט שהמודל מקבל — גם
 * ב-system prompt וגם ב-schema של create_task עצמו. ר' test-create-task-behavior.ts לבדיקה
 * חיה מול מודל אמיתי (multi-turn, מדמה בפועל את התרחישים).
 *
 * רקע 1 (2026-09-22): "תיצור לרוחי משימה" בלי המשך גרם למודל למלא taskName="משימה חדשה" — לא
 * ברירת מחדל בקוד, אלא המצאה של המודל כי ה-prompt הישן עודד "תמיד תקרא לכלי, מלא ברירות מחדל
 * למה שחסר" בלי לחריג את taskName (שאין לו ברירת מחדל הגיונית).
 *
 * רקע 2 (2026-09-24א): "תוסיף משימה לפרויקט X" (בלי לציין סוג) גרם למודל להחליט לבד וליצור
 * subitem בשלב הפעיל (findActiveStage) — התנהגות עסקית לא רצויה. עכשיו: פרויקט לבדו לא מספיק
 * כדי לבחור stage-task; המודל חייב לשאול.
 *
 * רקע 3 (2026-09-24ב): item נוצר בלי קישור לפרויקט בפועל (board_relation_mkqzzfgt ריק) —
 * תוקן ב-createGeneralTask (change_column_value נפרד, ר' opsWrite.ts). בסבב הזה גם הוחלף
 * הניסוח "משימה כללית המקושרת לפרויקט" ב"תחת הפרויקט" — **שהתברר כטעות נוספת, ר' רקע 4**.
 *
 * רקע 4 (2026-09-24ג, אירוע production שלישי — הטעות המתוקנת בקובץ הזה): "צור לי משימה תחת
 * הפרויקט גוטליב" פורש כ-taskKind='project' (project relation) — אבל "תחת" הוא מונח **היררכיה**
 * אצלנו (Project→Stage→Task), לא קישור! "תחת X" תמיד אמור לתאר subitem תחת שלב. המונח היחיד
 * ל-project relation הוא "מקושר/לקשר לפרויקט". המיפוי הנכון עכשיו:
 *   "תחת הפרויקט X" (בלי שלב)  → taskKind='stage', שואל איזה שלב (לא project relation!)
 *   "משימה שמקושרת לפרויקט X"  → taskKind='project'
 *   "משימה בפרויקט X" סתם      → שואל "לקשר לפרויקט, או תחת אחד משלביו?"
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

  // רקע 4 (התיקון המרכזי בסבב הזה): "תחת" = היררכיה, "מקושר/לקשר" = קישור — אף פעם לא הפוך
  check(
    "system prompt מבחין במפורש בין 'תחת' (היררכיה) ל'מקושר/לקשר' (קישור), עם אזהרה מפורשת",
    prompt.includes("שתי מילים שונות לגמרי") &&
      prompt.includes("מילת **היררכיה**") &&
      prompt.includes("מילת **קישור**"),
  );
  check(
    "system prompt אומר במפורש: לעולם אל תפרש 'תחת הפרויקט' כבקשת קישור",
    prompt.includes("לעולם אל תפרש 'תחת הפרויקט' כבקשה לקשר"),
  );
  check(
    "system prompt מגדיר את שלושת הסוגים במפורש (בלי פרויקט / מקושר לפרויקט / תחת שלב)",
    prompt.includes("שלושה סוגי משימה"),
  );
  check(
    "system prompt אוסר במפורש את המונח 'כללית' לתיאור משימה-עם-קישור-לפרויקט",
    prompt.includes("אל תשתמש במילה 'כללית' לתיאור (2)"),
  );
  check(
    "system prompt אוסר על המודל לבחור לבד בין לקשר-לפרויקט לתחת-שלב",
    prompt.includes("החלטה עסקית של המשתמש, אסור לך לבחור לבד"),
  );
  check(
    "system prompt נותן את נוסח השאלה המדויק ('לקשר', לא 'תחת הפרויקט', לא 'כללית')",
    prompt.includes("האם לקשר את המשימה לפרויקט, או ליצור אותה תחת אחד משלבי הפרויקט?"),
  );
  check(
    "system prompt מנחה: 'תחת הפרויקט X' בלי שלב → taskKind='stage' ישר, לא שאלת לקשר-או-שלב",
    prompt.includes("אתר את הפרויקט, **אל תשאל 'לקשר או תחת שלב'**") && prompt.includes("קרא ישר עם taskKind='stage'"),
  );
  check(
    "system prompt מנחה: ניסוח קישור מפורש ('מקושרת'/'קשר את המשימה') → taskKind='project' ישר",
    prompt.includes("'משימה שמקושרת לפרויקט X' / 'קשר את המשימה לפרויקט X'") && prompt.includes("taskKind='project' ישר"),
  );
  check(
    "system prompt מבהיר ששלב מפורש מכריע לבד, בלי שאלה",
    prompt.includes("stage מפורש") && prompt.includes("קרא ישר בלי שאלה בכלל"),
  );
  check(
    "system prompt מנחה איך להתמודד עם 'תחת שלב' בלי שם שלב (לקרוא עם taskKind='stage', להציג רשימה אמיתית)",
    prompt.includes("הכלי יחזיר שגיאה עם רשימת השלבים האמיתיים"),
  );
  check(
    "system prompt מדגיש שחובה להעביר project מחדש בכל קריאה חוזרת, לא רק פעם ראשונה",
    prompt.includes("project הוא לא 'פעם אחת וזהו'") && prompt.includes("גם אם כבר הועברו בקריאה קודמת"),
  );
  check("system prompt מנחה לשמור context בין הודעות", prompt.includes("שמור context בין הודעות") || prompt.includes("שמור context כדי לדעת"));
  check(
    "system prompt כבר לא מכיל את ההתנהגות הישנה (בחירת שלב פעיל אוטומטית)",
    !prompt.includes("המשימה תיווצר בשלב הנכון אוטומטית"),
  );
  check(
    "system prompt כבר לא ממפה 'תחת הפרויקט' ל-taskKind='project' (הטעות שתוקנה)",
    !prompt.includes("תעביר taskKind='project' ואל תשאל כלום"),
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
  check(
    "תיאור taskKind ב-schema מבהיר במפורש: 'תחת' = היררכיה/stage, 'מקושר' = קישור/project",
    taskKindDesc.includes("מילת **היררכיה**") && taskKindDesc.includes("לעולם לא 'project'"),
  );
  check("taskKind לא required (כי stage מפורש יכול להחליף אותו)", !CREATE_TASK_TOOL_DECL.input_schema.required.includes("taskKind"));

  const topDesc = CREATE_TASK_TOOL_DECL.description;
  check(
    "התיאור הראשי של הכלי (top-level) לא ממפה 'תחת הפרויקט' ל-(2)/project — מציין שזה על בסיס 'ביקש לקשר' בלבד",
    !topDesc.includes("או שאין stage מפורש והוזכר 'תחת הפרויקט'") && topDesc.includes("ביקש 'לקשר'"),
  );

  // ולידציה שהמשתמשים בלי הרשאת יצירה לא רואים את ההוראה הזו בכלל (התנאי הקיים canCreateTask)
  const goldi = resolveUserByKey("goldi")!; // finance — אין לו task:create/task:manage
  const goldiPrompt = systemPrompt(goldi);
  check("משתמש בלי הרשאת יצירה לא רואה את הוראת create_task בכלל", !goldiPrompt.includes("create_task"));

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main();
