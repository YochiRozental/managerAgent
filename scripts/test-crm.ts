/**
 * בדיקת בקרת ה-CRM (לידים · עסקאות · גבייה) מול הדאטה האמיתי.  npm run test:crm
 */
import { runCrmScan } from "../src/ops/crmScan.js";
import { logger } from "../src/utils/logger.js";

const ICON = { critical: "🔴", high: "🟠", normal: "⚪" } as const;

async function main() {
  logger.info("סורק לידים, עסקאות וגבייה…");
  const r = await runCrmScan(true);
  logger.info(`\nסה"כ ${r.counts.total} — 🔴 ${r.counts.critical} · 🟠 ${r.counts.high} · ⚪ ${r.counts.normal}`);

  const byArea: Record<string, typeof r.findings> = {};
  for (const f of r.findings) (byArea[f.project ?? "?"] ??= []).push(f);

  for (const [area, list] of Object.entries(byArea)) {
    logger.info(`\n══ ${area} (${list.length}) ══`);
    for (const f of list.slice(0, 20)) {
      logger.info(`${ICON[f.severity]} ${f.headline}`);
      logger.info(`   ${f.detail}  → ${f.who}`);
    }
    if (list.length > 20) logger.info(`   … ועוד ${list.length - 20}`);
  }
}

main().catch((err) => {
  logger.error(err, "test-crm failed");
  process.exit(1);
});
