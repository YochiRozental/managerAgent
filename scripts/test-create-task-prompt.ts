/**
 * בדיקה דטרמיניסטית (בלי AI, בלי Monday) שההוראה נגד המצאת taskName באמת נמצאת בטקסט שהמודל
 * מקבל — גם ב-system prompt וגם ב-schema של create_task עצמו. ר' test-create-task-behavior.ts
 * לבדיקה חיה מול מודל אמיתי (מדמה בפועל את "תיצור לרוחי משימה").
 *
 * רקע (2026-09-22): "תיצור לרוחי משימה" בלי המשך גרם למודל למלא taskName="משימה חדשה" — לא
 * ברירת מחדל בקוד (נבדק: אין "משימה חדשה" בשום מקום בקוד כ-fallback), אלא המצאה של המודל,
 * כנראה כי ה-system prompt הישן עודד "תמיד תקרא לכלי, מלא ברירות מחדל למה שחסר" בלי לחריג
 * את taskName (שאין לו ברירת מחדל הגיונית), וה-schema לא אסר במפורש placeholder.
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
    "system prompt מנחה במפורש לא לקרוא ל-create_task כשאין תוכן משימה",
    prompt.includes("אל תקרא ל-create_task בכלל"),
  );
  check("system prompt נותן דוגמה לשאלה המבהירה שיש לשאול", prompt.includes("מה המשימה שתרצה לפתוח"));
  check("system prompt אוסר placeholder 'משימה חדשה'", prompt.includes("משימה חדשה"));
  check("system prompt אוסר placeholder 'ללא שם'", prompt.includes("ללא שם"));
  check("system prompt אוסר placeholder 'משימה כללית'", prompt.includes("משימה כללית"));
  check(
    "system prompt מבהיר ש-taskName הוא תוכן בפועל ('להתקשר ליוסי') לא כותרת נפרדת",
    prompt.includes("להתקשר ליוסי"),
  );
  check(
    "system prompt מבחין בין taskName (אין ברירת מחדל) לשאר השדות (יש)",
    prompt.includes("לאלה יש ברירת מחדל הגיונית") || prompt.includes("ל-taskName אין"),
  );

  const taskNameDesc = CREATE_TASK_TOOL_DECL.input_schema.properties.taskName.description;
  check("תיאור taskName ב-schema אוסר המצאת ערך/placeholder", /placeholder|מומצא/.test(taskNameDesc));
  check("תיאור taskName ב-schema מנחה לשאול לפני קריאה לכלי", taskNameDesc.includes("שאל"));
  check("taskName עדיין required ב-schema (הבעיה היא מתי לקרוא לכלי, לא הסכמה עצמה)", CREATE_TASK_TOOL_DECL.input_schema.required.includes("taskName"));

  // ולידציה שהמשתמשים בלי הרשאת יצירה לא רואים את ההוראה הזו בכלל (התנאי הקיים canCreateTask)
  const goldi = resolveUserByKey("goldi")!; // finance — אין לו task:create/task:manage
  const goldiPrompt = systemPrompt(goldi);
  check("משתמש בלי הרשאת יצירה לא רואה את הוראת create_task בכלל", !goldiPrompt.includes("create_task"));

  logger.info(failed === 0 ? "\n✅ כל הבדיקות עברו" : `\n❌ ${failed} בדיקות נכשלו`);
  if (failed > 0) process.exit(1);
}

main();
