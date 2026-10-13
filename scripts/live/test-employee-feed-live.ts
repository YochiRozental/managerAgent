/**
 * בדיקה חיה אחת ממוקדת, קריאה בלבד: מאמתת שהשאילתה המשולבת (group+אחראי) שנבנתה ב-
 * fetchOwnedNewLeads/fetchOwnedDealsInGroup/fetchOwnedNewGeneralTasks עובדת בפועל מול Monday.
 * לא מדפיסה שום מידע אישי/טוקן/תוכן — רק ok/ספירות לכל אחת מחמש הקטגוריות.
 *
 *   npm run test:employee-feed-live -- [userKey]   (ברירת מחדל: moti)
 */
import "dotenv/config";
import { resolveUserByKey } from "../../src/identity/index.js";
import { getEmployeeFeed, employeeFeedCounts } from "../../src/ops/employeeFeed.js";
import { logger } from "../../src/utils/logger.js";

async function main() {
  const key = process.argv[2] ?? "moti";
  const user = resolveUserByKey(key);
  if (!user || !user.mondayUserId) {
    logger.error(`אין משתמש מזוהה עם mondayUserId בשם "${key}" — אפשרויות: moti, dov, eitan, ruchama, yochi`);
    process.exit(1);
  }

  logger.info(`שולף getEmployeeFeed (5 קטגוריות, group+אחראי בשרת)... [role=${user.role}]`);
  const feed = await getEmployeeFeed(user.mondayUserId);
  const counts = employeeFeedCounts(feed);
  logger.info({ counts }, "תוצאה — ספירות בלבד, בלי שמות/תוכן/מזהים");

  if (counts.errors.length > 0) {
    logger.error(`קטגוריות שנכשלו: ${counts.errors.join(", ")}`);
    process.exit(1);
  }
  logger.info("✅ השאילתה המשולבת (group+אחראי) עבדה בהצלחה בכל חמש הקטגוריות (read-only, לא נבדק תוכן).");
}

main().catch((err) => {
  logger.error(err, "test-employee-feed-live failed");
  process.exit(1);
});
