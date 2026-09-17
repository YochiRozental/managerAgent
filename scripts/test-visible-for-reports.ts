/**
 * visibleForReports (audit 2026-09-17) — הוכחה ש-3 הדוחות (תדריך בוקר / EOD summary / דוח שבועי
 * chronic) מכבדים snooze/resolved_by_reply דרך escalationDecision הקיים, בלי לשכפל את הלוגיקה.
 * DB מקומי אמיתי, אפס Monday אמיתי (escalationDecision עצמו כבר מכוסה ב-test-loop.ts — כאן רק
 * בודקים את ה-wiring של visibleForReports מול DB אמיתי + chronicFindings).
 *
 *   npm run test:visible-for-reports
 */
import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { chronicFindings, listActiveFindings, upsertFinding } from "../src/db/repositories/controlFindings.js";
import { visibleForReports } from "../src/ops/escalation.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

function cleanup(): void {
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__visrep_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__visrep_%'`);
}
cleanup();

const now = DateTime.now().setZone(env.TIMEZONE);

function seed(itemId: string, opts: { firstSeen?: DateTime } = {}): string {
  const findingKey = `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: `בדיקת visibleForReports ${itemId}`,
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    now: (opts.firstSeen ?? now).toISO()!,
  });
  // upsertFinding על finding_key חדש כותב first_seen=now תמיד (touchStmt לא נוגע בקיים על insert
  // ראשון) — אם רוצים firstSeen ישן, לדרוס ידנית אחרי היצירה (בדיוק לצורך "chronic" בבדיקה G).
  if (opts.firstSeen) {
    db.prepare(`UPDATE control_findings SET first_seen = ?, last_seen = ? WHERE finding_key = ?`).run(
      opts.firstSeen.toISO()!,
      now.toISO()!,
      findingKey,
    );
  }
  return findingKey;
}

function snooze(findingKey: string, untilISODate: string): void {
  db.prepare(`INSERT INTO finding_events (finding_key, event, payload_json) VALUES (?, 'snoozed', ?)`).run(
    findingKey,
    JSON.stringify({ byUser: "dov", snoozeUntil: untilISODate }),
  );
}

function markResolvedByReply(findingKey: string): void {
  db.prepare(`INSERT INTO finding_events (finding_key, event, payload_json) VALUES (?, 'resolved_by_reply', ?)`).run(
    findingKey,
    JSON.stringify({ byUser: "dov", action: "done" }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. snooze עתידי → מסונן
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── A. finding עם snooze עתידי → visibleForReports מסנן אותו ──");
{
  const itemId = "__visrep_future_snooze__";
  const fk = seed(itemId);
  snooze(fk, now.plus({ days: 5 }).toISODate()!);

  const active = listActiveFindings().filter((f) => f.itemId === itemId);
  check("הכנה: הממצא עדיין 'active' ב-DB (snooze לא סוגר אותו, רק משתיק אותו בדוחות)", active.length === 1);

  const visible = visibleForReports(active, now);
  check("visibleForReports מסנן אותו כשה-snooze עדיין בתוקף", visible.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. snooze שפג → חוזר אוטומטית
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── B. אותו finding, אחרי שה-snooze פג → חוזר בלי פעולה ידנית ──");
{
  const itemId = "__visrep_expired_snooze__";
  const fk = seed(itemId);
  snooze(fk, now.minus({ days: 2 }).toISODate()!); // snoozeUntil כבר עבר

  const active = listActiveFindings().filter((f) => f.itemId === itemId);
  const visible = visibleForReports(active, now);
  check("snoozeUntil שעבר → הממצא חוזר להיות visible, אין דגל/פעולה נוספת שצריך לאפס", visible.length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. resolved_by_reply → מסונן
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── C. resolved_by_reply → visibleForReports מסנן (side-effect מכוון של שימוש חוזר ב-escalationDecision) ──");
{
  const itemId = "__visrep_resolved_by_reply__";
  const fk = seed(itemId);
  markResolvedByReply(fk);

  const active = listActiveFindings().filter((f) => f.itemId === itemId);
  const visible = visibleForReports(active, now);
  check("ממצא שכבר resolved_by_reply לא מוצג כחריג פעיל", visible.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// D. finding רגיל (בלי snooze/resolved) → נשאר
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── D. finding רגיל בלי snooze/resolved_by_reply → ממשיך להופיע (non-regression) ──");
{
  const itemId = "__visrep_normal__";
  seed(itemId);

  const active = listActiveFindings().filter((f) => f.itemId === itemId);
  const visible = visibleForReports(active, now);
  check("ממצא רגיל עובר את הפילטר ללא שינוי", visible.length === 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// G. chronic (דוח שבועי) — ותיק+snoozed מסונן, ותיק-בלי-snooze נשאר
// ─────────────────────────────────────────────────────────────────────────────
logger.info("── G. chronicFindings + visibleForReports — ותיק עם snooze פעיל מסונן לפני רינדור weekly ──");
{
  const weekAgoIso = now.minus({ days: 7 }).toISO()!;
  const tenDaysAgo = now.minus({ days: 10 });

  const chronicSnoozedId = "__visrep_chronic_snoozed__";
  const fkChronicSnoozed = seed(chronicSnoozedId, { firstSeen: tenDaysAgo });
  snooze(fkChronicSnoozed, now.plus({ days: 3 }).toISODate()!);

  const chronicNormalId = "__visrep_chronic_normal__";
  seed(chronicNormalId, { firstSeen: tenDaysAgo });

  const rawChronic = chronicFindings(weekAgoIso).filter((f) => f.itemId === chronicSnoozedId || f.itemId === chronicNormalId);
  check("הכנה: שני הממצאים הוותיקים נמצאים ב-chronicFindings הגולמי (10 ימים > שבוע)", rawChronic.length === 2);

  const visibleChronic = visibleForReports(rawChronic, now);
  check(
    "אחרי visibleForReports: רק הממצא בלי snooze נשאר ברשימת ה-chronic",
    visibleChronic.length === 1 && visibleChronic[0]?.itemId === chronicNormalId,
    JSON.stringify(visibleChronic.map((f) => f.itemId)),
  );
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות visibleForReports עברו ✅ (אפס קריאות Monday אמיתיות)");
