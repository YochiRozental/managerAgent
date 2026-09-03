/**
 * בדיקת שלב 1 — שלוש התצוגות מול הדאטה האמיתי ב-Monday (קריאה בלבד, לא כותב כלום).
 * שימוש:  npm run test:ops           (ברירת מחדל: מוטי)
 *         npm run test:ops -- dov    (או eitan / ruchama / yochi)
 */
import { resolveUserByKey } from "../src/identity/index.js";
import { getEmployeeDashboard, type DashboardTask } from "../src/ops/dashboard.js";
import { logger } from "../src/utils/logger.js";

function line(t: DashboardTask): string {
  const bits: string[] = [];
  if (t.dueDate) bits.push(t.flags.overdue ? `⚠ באיחור ${t.flags.daysOverdue} ימים (${t.dueDate})` : `📅 ${t.dueDate}`);
  else bits.push("בלי תאריך");
  if (t.status) bits.push(t.status);
  if (t.priority) bits.push(t.priority);
  if (t.responsibleParty) bits.push(`באחריות: ${t.responsibleParty}`);
  const where = t.stageName ? `${t.context} › ${t.stageName}` : t.context;
  return `   • ${t.name}\n     ${where}\n     ${bits.join(" · ")}`;
}

function section(title: string, tasks: DashboardTask[]) {
  logger.info(`\n━━ ${title} (${tasks.length}) ━━`);
  if (tasks.length === 0) {
    logger.info("   (ריק)");
    return;
  }
  for (const t of tasks.slice(0, 25)) logger.info(line(t));
  if (tasks.length > 25) logger.info(`   … ועוד ${tasks.length - 25}`);
}

async function main() {
  const key = process.argv[2] ?? "moti";
  const user = resolveUserByKey(key);
  if (!user) {
    logger.error(`אין משתמש בשם "${key}". אפשרויות: moti, dov, eitan, ruchama, goldi, yochi`);
    process.exit(1);
  }

  logger.info(`מושך את לוח הבקרה של ${user.name} (${user.role}, monday=${user.mondayUserId ?? "—"})...`);
  const dash = await getEmployeeDashboard(user);

  logger.info(
    `\nסה"כ משימות פתוחות: ${dash.counts.totalOpen} | היום שלי: ${dash.counts.myDay} | דורש תשומת לב: ${dash.counts.needsAttention} | מחכים ממני: ${dash.counts.waitingOnMe}`,
  );

  section("היום שלי", dash.myDay);
  section("דורש תשומת לב", dash.needsAttention);
  section("מחכים ממני", dash.waitingOnMe);
}

main().catch((err) => {
  logger.error(err, "test-ops failed");
  process.exit(1);
});
