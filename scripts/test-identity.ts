/**
 * בדיקת שכבת הזהות — לא נוגע ב-Monday/Google, רק מריץ את הלוגיקה המקומית.
 * מריץ: npm run test:identity
 */
import { toAnthropicTools } from "../src/integrations/claude/tools.js";
import {
  TEAM_DIRECTORY,
  resolveUserByWhatsappJid,
  resolveUserByMondayId,
  resolveUserByEmail,
  resolveUserByKey,
  userCan,
} from "../src/identity/index.js";
import { logger } from "../src/utils/logger.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`❌ ${msg}`);
  logger.info(`✅ ${msg}`);
}

function main() {
  logger.info("— ספר הצוות —");
  for (const m of TEAM_DIRECTORY) {
    const u = resolveUserByKey(m.key)!;
    logger.info(
      `  ${u.name} · ${u.role} · monday=${u.mondayUserId ?? "—"} · הרשאות: ${u.permissions.length}`,
    );
  }

  logger.info("— זיהוי לפי ערוצים —");
  assert(resolveUserByWhatsappJid("972527530044@s.whatsapp.net")?.key === "moti", "JID של מוטי → moti");
  assert(resolveUserByWhatsappJid("972500000000@s.whatsapp.net") === null, "JID לא מוכר → null");
  assert(resolveUserByMondayId("62982081")?.key === "dov", "מזהה Monday 62982081 → dov");
  assert(resolveUserByEmail("EITAN@gotlib.biz")?.key === "eitan", "מייל (case-insensitive) → eitan");
  assert(resolveUserByKey("nobody") === null, "מפתח לא קיים → null");

  logger.info("— הרשאות לפי תפקיד —");
  const moti = resolveUserByKey("moti");
  const ruchama = resolveUserByKey("ruchama");
  const goldi = resolveUserByKey("goldi");
  const dov = resolveUserByKey("dov");

  const yochi = resolveUserByKey("yochi");

  assert(userCan(moti, "approve:sensitive"), "מוטי מאשר פעולות רגישות");
  assert(userCan(moti, "view:all_work"), "מוטי רואה הכל");
  assert(!userCan(yochi, "approve:sensitive"), "יוכי (אדמין) לא מאשר פעולות רגישות — רק מוטי");
  assert(userCan(yochi, "system:admin"), "יוכי כן אדמין מערכת");
  assert(!userCan(ruchama, "task:manage"), "רוחמה לא מקצה לאחרים / מנהלת פרויקט");
  assert(userCan(ruchama, "task:update_own"), "רוחמה מעדכנת משימות שלה");
  assert(userCan(ruchama, "task:create"), "רוחמה יוצרת לעצמה משימות המשך");
  assert(!userCan(ruchama, "view:finance"), "רוחמה לא רואה כספים");
  assert(userCan(goldi, "finance:manage"), "גולדי מנהלת גבייה");
  assert(!userCan(goldi, "project:manage"), "גולדי לא מנהלת פרויקטים");
  assert(userCan(dov, "project:manage"), "דוב מנהל פרויקטים כולל רישוי");
  assert(!userCan(dov, "approve:sensitive"), "דוב לא מאשר פעולות רגישות (כסף/מחיקה)");
  assert(!userCan(null, "view:own_work"), "משתמש לא מזוהה — אפס הרשאות");

  logger.info("— סינון כלים ל-AI לפי הרשאות —");
  const motiTools = toAnthropicTools(moti).map((t) => t.name);
  const ruchamaTools = toAnthropicTools(ruchama).map((t) => t.name);
  const anonTools = toAnthropicTools(null).map((t) => t.name);
  logger.info(`  מוטי: ${motiTools.length} כלים`);
  logger.info(`  רוחמה: ${ruchamaTools.length} כלים (${ruchamaTools.join(", ")})`);
  assert(motiTools.includes("send_meeting_summary_email"), "מוטי מקבל את כלי המייל");
  assert(!ruchamaTools.includes("send_meeting_summary_email"), "רוחמה לא מקבלת את כלי המייל");
  assert(!ruchamaTools.includes("assign_monday_task"), "רוחמה לא מקבלת הקצאת משימה לאחרים");
  assert(ruchamaTools.includes("create_monday_task"), "רוחמה כן מקבלת יצירת משימת המשך");
  assert(ruchamaTools.includes("list_my_work"), "רוחמה כן מקבלת 'המשימות שלי'");
  assert(anonTools.length === 0, "משתמש לא מזוהה — 0 כלים ל-AI");

  logger.info("");
  logger.info("כל הבדיקות עברו ✅");
}

try {
  main();
} catch (err) {
  logger.error(err, "test-identity failed");
  process.exit(1);
}
