/**
 * בדיקה ל-scripts/maintenance/backfill-escalation-identity.ts (audit 2026-09-16): מוודאת שה-dry-run
 * לא כותב, שה-apply מעדכן רק escalation "safe" (finding פעיל עם itemId+itemSource תקינים דרך
 * finding_key בלבד), לא נוגע ב-body/user_key/seen_at/finding_key, לא ממציא זהות ל-findings
 * שלגיטימית בלי item_id (project/CRM), ושהרצה שנייה idempotent — 0 עדכונים.
 * מייבאת ומפעילה את runBackfill האמיתי (לא עותק מקביל) — DB מקומי אמיתי, אפס Monday.
 *
 *   npm run test:backfill-escalations
 */

import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { addNotification, type Notification } from "../src/db/repositories/notifications.js";
import { runBackfill } from "./maintenance/backfill-escalation-identity.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const MARK = "__bf_test__";

function cleanup(): void {
  db.exec(`DELETE FROM notifications WHERE finding_key LIKE '${MARK}%'`);
  db.exec(`DELETE FROM control_findings WHERE finding_key LIKE '${MARK}%'`);
}
cleanup();

function getNotification(id: number): Notification {
  const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id) as {
    id: number;
    user_key: string;
    kind: string;
    body: string;
    finding_key: string | null;
    item_id: string | null;
    item_source: string | null;
    context_json: string | null;
    created_at: string;
    seen_at: string | null;
  };
  return {
    id: row.id,
    userKey: row.user_key,
    kind: row.kind,
    body: row.body,
    findingKey: row.finding_key,
    itemId: row.item_id,
    itemSource: row.item_source,
    context: row.context_json ? JSON.parse(row.context_json) : null,
    createdAt: row.created_at,
    seenAt: row.seen_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

function main(): void {
  // --- הכנת הנתונים: 4 תרחישים, בדיוק לפי הבקשות בשיחה ---

  // 1) safe: escalation ישנה בלי context, finding פעיל עם itemId+itemSource תקינים.
  const fkSafe = `${MARK}:safe`;
  const findingSafe = upsertFinding({
    findingKey: fkSafe,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    project: "בדיקת backfill",
    headline: "בדיקה: משימה שצריכה ריפוי",
    detail: "8 ימי עבודה בלי תזוזה",
    itemId: "it-safe-1",
    itemSource: "general",
    dueDate: "2026-09-20",
    now: now(),
  });
  const notifSafeId = addNotification("dov", "escalation", 'הסלמה: "בדיקה: משימה שצריכה ריפוי" — 8 ימי עבודה', fkSafe);
  const beforeSafe = getNotification(notifSafeId);
  check("הכנה: notification safe נוצרה בלי item_id (כמו המצב האמיתי)", beforeSafe.itemId === null);

  // 2) skipped-no-identity: finding פעיל קיים, אבל בלי itemId (כמו project_stuck/CRM אמיתי).
  const fkNoIdentity = `${MARK}:no-identity`;
  upsertFinding({
    findingKey: fkNoIdentity,
    kind: "project_stuck",
    severity: "high",
    who: "מוטי",
    headline: "בדיקה: פרויקט תקוע לדוגמה",
    detail: "—",
    now: now(),
  });
  const notifNoIdentityId = addNotification("moti", "escalation", 'הסלמה: "בדיקה: פרויקט תקוע לדוגמה"', fkNoIdentity);

  // 3) orphan: finding_key שאין לו control_finding פעיל תואם בכלל.
  const fkOrphan = `${MARK}:orphan-does-not-exist`;
  const notifOrphanId = addNotification("moti", "escalation", "הסלמה על ממצא שכבר לא קיים בכלל", fkOrphan);

  // 4) notification מסוג אחר (לא escalation) — לא אמור להיות מועמד בכלל, גם אם חסר לו itemId.
  const fkOtherKind = `${MARK}:other-kind`;
  upsertFinding({
    findingKey: fkOtherKind,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקה: נודג' רגיל",
    detail: "—",
    itemId: "it-other-1",
    itemSource: "general",
    now: now(),
  });
  const notifNudgeId = addNotification("dov", "nudge", "פנייה רגילה מהבקרה — לא escalation", fkOtherKind);
  const beforeNudge = getNotification(notifNudgeId);

  // --- שלב א: dry-run לא כותב כלום ---
  const dry = runBackfill(false, { silent: true });
  check("dry-run: applied=false", dry.applied === false);
  check("dry-run: updated=0", dry.updated === 0);
  const afterDry = getNotification(notifSafeId);
  check("dry-run: notification safe לא השתנתה בפועל (עדיין בלי item_id)", afterDry.itemId === null);
  check(
    "dry-run: הממצא ה-safe שלנו סווג כ-safe בדוח (candidates)",
    dry.safe.some((s) => s.row.id === notifSafeId),
  );
  check(
    "dry-run: הממצא ה-no-identity שלנו סווג כ-skipped-no-identity",
    dry.skippedNoIdentity.some((s) => s.row.id === notifNoIdentityId),
  );
  check(
    "dry-run: ה-orphan שלנו סווג כ-orphan",
    dry.orphan.some((r) => r.id === notifOrphanId),
  );
  check(
    "dry-run: notification מסוג 'nudge' לא נכנסה לרשימת candidates בכלל",
    !dry.candidates.some((r) => r.id === notifNudgeId),
  );

  // --- שלב ב: apply ---
  const applied = runBackfill(true, { silent: true });
  check("apply: applied=true", applied.applied === true);
  check("apply: updated > 0 (יש לפחות את ה-safe שלנו)", applied.updated > 0);

  const safeAfter = getNotification(notifSafeId);
  check("apply: safe קיבלה item_id מה-finding", safeAfter.itemId === "it-safe-1", `קיבל: ${safeAfter.itemId}`);
  check("apply: safe קיבלה item_source מה-finding", safeAfter.itemSource === "general", `קיבל: ${safeAfter.itemSource}`);
  check(
    "apply: safe קיבלה context עם taskName מה-finding",
    (safeAfter.context as { taskName?: string } | null)?.taskName === findingSafe.headline,
  );
  check("apply: body לא השתנה", safeAfter.body === beforeSafe.body);
  check("apply: user_key לא השתנה", safeAfter.userKey === beforeSafe.userKey);
  check("apply: finding_key לא השתנה", safeAfter.findingKey === beforeSafe.findingKey);
  check("apply: seen_at לא השתנה (עדיין unseen)", safeAfter.seenAt === beforeSafe.seenAt);
  check("apply: created_at לא השתנה", safeAfter.createdAt === beforeSafe.createdAt);

  const noIdentityAfter = getNotification(notifNoIdentityId);
  check(
    "apply: notification עם finding-בלי-זהות נשארה ללא שינוי (לא הומצאה זהות)",
    noIdentityAfter.itemId === null && noIdentityAfter.itemSource === null,
  );

  const orphanAfter = getNotification(notifOrphanId);
  check("apply: notification orphan נשארה ללא שינוי", orphanAfter.itemId === null);

  const nudgeAfter = getNotification(notifNudgeId);
  check(
    "apply: notification מסוג אחר (nudge) לא נגעו בה, גם שהיה לה finding עם זהות תקינה",
    nudgeAfter.itemId === null && nudgeAfter.itemSource === null,
  );
  check("apply: nudge.body/userKey/seenAt לא השתנו", nudgeAfter.body === beforeNudge.body && nudgeAfter.userKey === beforeNudge.userKey && nudgeAfter.seenAt === beforeNudge.seenAt);

  // --- שלב ג: apply שני — idempotent, 0 עדכונים ---
  const appliedAgain = runBackfill(true, { silent: true });
  check("apply שני: updated=0 (idempotent)", appliedAgain.updated === 0, `קיבל: ${appliedAgain.updated}`);
  check(
    "apply שני: ה-notification ה-safe שלנו כבר לא ב-candidates (יש לה זהות)",
    !appliedAgain.candidates.some((r) => r.id === notifSafeId),
  );

  cleanup();

  if (failed > 0) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\n✅ כל הבדיקות עברו");
}

try {
  main();
} catch (err) {
  cleanup();
  logger.error(err, "test-backfill-escalation-identity failed");
  process.exit(1);
}
