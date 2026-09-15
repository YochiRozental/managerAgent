/**
 * בדיקה ממוקדת (2026-09-17): התראת "escalation" (רמה 2/3 בהסלמה) חייבת לשאת itemId/itemSource/
 * findingKey — אותו context מובנה שכבר קיים על ה-finding, בלי קריאה חדשה ל-Monday ובלי ניחוש.
 * DB מקומי אמיתי, אפס Monday אמיתי, אפס שינוי בתנאי/תזמון/טקסט ההסלמה עצמם.
 *
 *   npm run test:escalation-context
 */

import { db } from "../src/db/db.js";
import { upsertFinding, type StoredFinding } from "../src/db/repositories/controlFindings.js";
import { addNotification, listUnseenNotifications } from "../src/db/repositories/notifications.js";
import { escalationNotifContext } from "../src/ops/escalation.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const MARK = "__esc_ctx_test__";
const findingKey = `${MARK}:1`;

function cleanup(): void {
  db.exec(`DELETE FROM notifications WHERE finding_key = '${findingKey}'`);
  db.exec(`DELETE FROM control_findings WHERE finding_key = '${findingKey}'`);
}
cleanup();

async function main() {
  // 1. ממצא עם itemId/itemSource/project/dueDate ידועים — בדיוק מה ש-upsertFinding שומר בסבב
  //    האמיתי (escalation.ts שלב 1), בלי לגעת ב-Monday.
  const finding: StoredFinding = upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    project: "בדיקת הקשר להסלמה",
    headline: 'בדיקה: "הגשת תכניות" — התראת הסלמה',
    detail: "5 ימי עבודה בלי תזוזה",
    itemId: "it-esc-ctx-1",
    itemSource: "general",
    dueDate: "2026-09-20",
    now: new Date().toISOString(),
  });

  // 2. escalationNotifContext הוא ה-helper שנוסף ב-escalation.ts — פונקציה טהורה, בלי DB/Monday.
  const ctx = escalationNotifContext(finding);
  check("escalationNotifContext.itemId = finding.itemId", ctx.itemId === finding.itemId, JSON.stringify(ctx));
  check("escalationNotifContext.itemSource = finding.itemSource", ctx.itemSource === finding.itemSource);
  check("escalationNotifContext.context.taskName = finding.headline", ctx.context.taskName === finding.headline);
  check("escalationNotifContext.context.project = finding.project", ctx.context.project === finding.project);
  check(
    "escalationNotifContext.context.currentDueDateISO = finding.dueDate",
    ctx.context.currentDueDateISO === finding.dueDate,
  );

  // 3. בדיוק מה ששני מקומות הקריאה ב-escalation.ts (רמה 2 למנהל הפרויקט, רמה 3 למוטי) עושים היום —
  //    addNotification(kind="escalation", ...) עם ה-ctx הזה. קוראים כאן ל-addNotification/
  //    listUnseenNotifications האמיתיים (לא מדומים) כדי להוכיח שהשורה נשמרת ומוחזרת עם השדות.
  const notifId = addNotification(
    "dov",
    "escalation",
    `הסלמה בפרויקט שלך (${finding.project}):\n"${finding.headline}" — 2 ימי עבודה בלי תזוזה. אחראי: ${finding.who}.`,
    finding.findingKey,
    ctx,
  );
  check("addNotification החזיר id", typeof notifId === "number" && notifId > 0);

  const saved = listUnseenNotifications("dov").find((n) => n.id === notifId);
  check("ההתראה נמצאת ב-listUnseenNotifications", !!saved);
  if (saved) {
    check("saved.kind === 'escalation'", saved.kind === "escalation");
    check("saved.itemId נשמר", saved.itemId === "it-esc-ctx-1", `קיבל: ${saved.itemId}`);
    check("saved.itemSource נשמר", saved.itemSource === "general", `קיבל: ${saved.itemSource}`);
    check("saved.findingKey נשמר", saved.findingKey === findingKey, `קיבל: ${saved.findingKey}`);
    check(
      "saved.context.taskName נשמר",
      (saved.context as { taskName?: string } | null)?.taskName === finding.headline,
    );
    check(
      "saved.context.currentDueDateISO נשמר",
      (saved.context as { currentDueDateISO?: string } | null)?.currentDueDateISO === "2026-09-20",
    );
    // ה-UI (ui.html) פותח שיחה רק כש-itemId+itemSource+findingKey שלושתם קיימים בפועל — בדיוק
    // התנאי שה-fix הזה בא לספק, בלי לשנות את תנאי ה-ACTIONABLE_NOTIF_KINDS עצמו (זה נבדק ידנית ב-UI).
    check(
      "יש מספיק context כדי לפתוח שיחה (itemId && itemSource && findingKey)",
      !!(saved.itemId && saved.itemSource && saved.findingKey),
    );
  }

  // 4. שורות escalation ישנות (בלי context, כמו לפני התיקון) לא אמורות "להירפא" — dedup מחזיר את
  //    ה-id הקיים בלי לעדכן context. מדמים שורה ישנה כזו (kind='escalation' בלי ctx) ומוודאים
  //    שקריאה חוזרת עם אותו (user,findingKey,kind) לא דורסת/לא יוצרת שורה שנייה ולא "מתקנת" אותה —
  //    בדיוק ההתנהגות שהתבקשה: "בלי migration לנתונים ישנים".
  const legacyFindingKey = `${MARK}:legacy`;
  db.exec(`DELETE FROM notifications WHERE finding_key = '${legacyFindingKey}'`);
  const legacyId = addNotification("dov", "escalation", "הסלמה ישנה בלי context (מדמה נתון קדום)", legacyFindingKey);
  const legacyAgainId = addNotification(
    "dov",
    "escalation",
    "טקסט אחר — אבל אותו user+findingKey+kind עדיין unseen",
    legacyFindingKey,
    ctx,
  );
  check("dedup: לא נוצרה שורה שנייה על אותו finding/kind/user", legacyId === legacyAgainId);
  const legacySaved = listUnseenNotifications("dov").find((n) => n.id === legacyId);
  check(
    "שורה ישנה בלי context נשארת בלי itemId (אין migration אוטומטי)",
    !!legacySaved && legacySaved.itemId === null && legacySaved.itemSource === null,
  );
  db.exec(`DELETE FROM notifications WHERE finding_key = '${legacyFindingKey}'`);

  cleanup();

  if (failed > 0) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\n✅ כל הבדיקות עברו");
}

main().catch((err) => {
  cleanup();
  logger.error(err, "test-escalation-context failed");
  process.exit(1);
});
