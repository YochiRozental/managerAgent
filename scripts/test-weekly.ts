/**
 * מריץ את הדוח השבועי ומדפיס אותו.  npm run test:weekly
 * כותב notification למוטי + לתור ה-WhatsApp.
 */
import { buildWeeklyReport } from "../src/ops/weeklyReport.js";
import { logger } from "../src/utils/logger.js";

buildWeeklyReport()
  .then((r) => {
    logger.info("\n" + r.text);
  })
  .catch((err) => {
    logger.error(err, "test-weekly failed");
    process.exit(1);
  });
