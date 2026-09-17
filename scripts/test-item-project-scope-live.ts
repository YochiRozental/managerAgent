/**
 * בדיקת אינטגרציה חיה (קריאה בלבד — אין שום כתיבה/יצירה) ל-resolveItemProjectScope
 * (src/integrations/monday/opsRead.ts) — מוודאת שזיהוי "לאיזה פרויקט שייך פריט" עובד נכון מול
 * המבנה *האמיתי* ב-Monday: project/stage/subitem/general-task/lead. משלימה את
 * test-project-scope.ts (שם הלוגיקה שמעליו — ההרשאות ב-actions.ts — נבדקת עם דאטה מזויף).
 *
 * מזהי הפריטים כאן אמיתיים בפרודקשן — נמצאו ואומתו ידנית ב-2026-09-24 (פרויקט "בית הכנסת
 * נתיבות שלום סלונים עמנואל" 1553362197 ושלביו; משימת משרד "לעצב את מרכז פסגה" המקושרת לפרויקט
 * "מרכז פסג\"ה קרית ארבע" 1552046340; ליד קיים 1823741570). זו לא בדיקת רגרסיה על הקוד בלבד —
 * אם היא נכשלת יום אחד, ייתכן שהפריטים/הקישורים האלה השתנו/נמחקו ב-Monday בעצמו, לא רק שהקוד
 * התקלקל. דורש MONDAY_API_TOKEN אמיתי (כמו test-monday.ts/test-ops.ts).
 *
 *   npm run test:item-project-scope
 */

import "dotenv/config";
import { resolveItemProjectScope } from "../src/integrations/monday/opsRead.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
function check(label: string, cond: boolean, extra = "") {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
}

async function main() {
  const PROJECT_ID = "1553362197"; // בית הכנסת נתיבות שלום סלונים עמנואל

  {
    const scope = await resolveItemProjectScope(PROJECT_ID);
    check("project item עצמו → projectId = עצמו", scope?.projectId === PROJECT_ID, JSON.stringify(scope));
  }
  {
    const scope = await resolveItemProjectScope("1588686284"); // "שלב 2: תיק מידע" בפרויקט הנ"ל
    check(
      "stage מזוהה נכון לפרויקט (connect_boards4__1 חוזר על הפרויקט המקורי)",
      scope?.projectId === PROJECT_ID,
      JSON.stringify(scope),
    );
  }
  {
    const scope = await resolveItemProjectScope("1588686692"); // subitem תחת השלב הנ"ל
    check(
      "subitem מזוהה נכון דרך parent_item (השלב) → project",
      scope?.projectId === PROJECT_ID,
      JSON.stringify(scope),
    );
  }
  {
    const scope = await resolveItemProjectScope("3013879975"); // משימת משרד "לעצב את מרכז פסגה"
    check(
      "general task עם board_relation_mkqzzfgt מטופלת נכון (מקושרת לפרויקט מרכז פסגה)",
      scope?.projectId === "1552046340",
      JSON.stringify(scope),
    );
  }
  {
    const scope = await resolveItemProjectScope("1823741570"); // ליד קיים
    check(
      "ליד: לא נופל על עמודות שלא קיימות בבורד שלו, לא ממציא פרויקט (projectId=null)",
      scope !== null && scope.projectId === null,
      JSON.stringify(scope),
    );
  }
  {
    const scope = await resolveItemProjectScope("999999999999"); // פריט שלא קיים
    check("פריט שלא קיים ב-Monday → null (לא זורק, לא ממציא)", scope === null, JSON.stringify(scope));
  }

  logger.info(failed === 0 ? "\n✅ כל בדיקות ה-live scope resolution עברו" : `\n❌ ${failed} נכשלו`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "test-item-project-scope-live נכשל עם שגיאה לא צפויה");
  process.exit(1);
});
