/**
 * מריץ סבב יומי אחד של מנוע הבקרה (סריקה → שמירה → הסלמה → תדריך).  npm run test:cycle
 * כותב ל-SQLite המקומי ולתור ה-WhatsApp — לבדיקה מקומית בלבד.
 */
import { runDailyControlCycle } from "../src/ops/escalation.js";
import { listUnseenNotifications } from "../src/db/repositories/notifications.js";
import { listUnsentWhatsapp } from "../src/db/repositories/whatsappOutbox.js";
import { logger } from "../src/utils/logger.js";

async function main() {
  const r = await runDailyControlCycle();
  logger.info(
    `\nסבב הסתיים: ${r.findings} ממצאים · ${r.forManager} למוטי · ${r.escalations.length} הסלמות · תדריך בתור: ${r.briefingQueued}`,
  );

  if (r.escalations.length) {
    logger.info("\nהסלמות:");
    for (const e of r.escalations) logger.info(`  רמה ${e.level} → ${e.who}: ${e.headline}`);
  }

  for (const key of ["moti", "dov", "eitan", "ruchama"]) {
    const n = listUnseenNotifications(key);
    if (n.length) {
      logger.info(`\nהודעות ל-${key} (${n.length}):`);
      for (const x of n) logger.info(`  [${x.kind}] ${x.body.slice(0, 120).replace(/\n/g, " ⏎ ")}`);
    }
  }

  const outbox = listUnsentWhatsapp();
  if (outbox.length) {
    logger.info(`\nתור WhatsApp (${outbox.length}):`);
    for (const m of outbox) logger.info(`  → ${m.jid}\n${m.body}`);
  }
}

main().catch((err) => {
  logger.error(err, "test-cycle failed");
  process.exit(1);
});
