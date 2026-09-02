import { env } from "../src/config/env.js";
import { createTask, listBoards } from "../src/integrations/monday/tasks.js";
import { logger } from "../src/utils/logger.js";

async function main() {
  if (!env.MONDAY_BOARD_ID) {
    logger.info("MONDAY_BOARD_ID not set — listing your boards so you can pick one:");
    const boards = await listBoards();
    for (const b of boards) {
      logger.info(`  ${b.id}  ${b.name}`);
    }
    logger.info("Set MONDAY_BOARD_ID in .env to one of the ids above, then re-run: npm run test:monday");
    return;
  }

  logger.info(`Creating a test task on board ${env.MONDAY_BOARD_ID}...`);
  const item = await createTask("בדיקת חיבור מהסוכן ✅");
  logger.info({ item }, "Created item — check the Monday.com board in your browser");
}

main().catch((err) => {
  logger.error(err, "test-monday failed");
  process.exit(1);
});
