/**
 * בדיקת מנוע הבקרה (שלב 4) מול הדאטה האמיתי.  npm run test:control
 */
import { runControlScan } from "../src/ops/controlScan.js";
import { logger } from "../src/utils/logger.js";

const ICON = { critical: "🔴", high: "🟠", normal: "⚪" } as const;

async function main() {
  logger.info("סורק את כל המשרד… (כמה שניות)");
  const r = await runControlScan();

  logger.info(
    `\nסה"כ ${r.counts.total} ממצאים — 🔴 ${r.counts.critical} · 🟠 ${r.counts.high} · ⚪ ${r.counts.normal}`,
  );

  logger.info(`\n══ למוטי (critical + high): ${r.forManager.length} ══`);
  for (const f of r.forManager) {
    logger.info(`${ICON[f.severity]} [${f.kind}] ${f.headline}`);
    logger.info(`   ${f.detail}`);
    logger.info(`   → ${f.who}`);
  }

  logger.info(`\n══ שאר הממצאים (${r.counts.normal}) ══`);
  for (const f of r.findings.filter((x) => x.severity === "normal")) {
    logger.info(`⚪ [${f.kind}] ${f.headline}  → ${f.who}`);
  }

  logger.info(`\n══ ממצאים לפי אחראי ══`);
  for (const p of r.byPerson) logger.info(`   ${p.who}: ${p.count}`);
}

main().catch((err) => {
  logger.error(err, "test-control failed");
  process.exit(1);
});
