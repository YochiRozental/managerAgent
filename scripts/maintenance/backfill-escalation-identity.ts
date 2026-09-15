/**
 * כלי תחזוקה חד-פעמי, idempotent (audit 2026-09-15/16): notifications מסוג "escalation" שנוצרו
 * לפני ש-escalation.ts צירף להן context (item_id/item_source/context_json — ר' escalationNotifContext)
 * נשארות תקועות בלי הכפתור "טיפול בשיחה" לצמיתות, כי dedup ב-addNotification לא מעדכן שורה unseen
 * קיימת גם כשה-finding שלה כבר התרפא (control_findings.item_id) — ר' השיחה שהובילה לכלי הזה.
 *
 * מה זה עושה: לכל notification כזו, מחפש finding *פעיל* עם אותו finding_key (PRIMARY KEY על
 * control_findings — קישור חד-משמעי, לא ניחוש) שכבר יש לו item_id+item_source תקינים, ומעתיק את
 * ה-context ממנו — בדיוק אותה לוגיקה ש-escalation.ts כבר משתמש בה ל-notifications חדשות
 * (escalationNotifContext), לא לוגיקה מקבילה. findings בלי זהות לגיטימית (project_stuck/CRM) לא
 * מקבלים זהות מומצאת — פשוט מדולגים.
 *
 * ברירת מחדל: DRY-RUN בלבד — מדפיס דוח, לא נוגע ב-DB. כתיבה בפועל רק עם --apply.
 * Idempotent: ה-SELECT וה-UPDATE משתמשים באותו תנאי (item_id IS NULL OR item_source IS NULL) —
 * אחרי backfill השורה כבר לא תואמת, אז --apply שני מעדכן 0.
 * לא נוגע ב-body/user_key/seen_at/finding_key/escalation_level/control_findings.
 *
 *   npm run maintenance:backfill-escalations          # dry-run (ברירת מחדל, גם בלי הדגל)
 *   npm run maintenance:backfill-escalations:apply     # כתיבה בפועל
 */

import { pathToFileURL } from "node:url";
import { listActiveFindings, type StoredFinding } from "../../src/db/repositories/controlFindings.js";
import { escalationNotifContext } from "../../src/ops/escalation.js";
import { db } from "../../src/db/db.js";
import { logger } from "../../src/utils/logger.js";

export interface CandidateRow {
  id: number;
  user_key: string;
  finding_key: string | null;
  item_id: string | null;
  item_source: string | null;
}

const APPLY = process.argv.includes("--apply");

// אותו תנאי בדיוק ב-SELECT וב-UPDATE — זה מה שהופך את הריצה ל-idempotent (ר' docstring למעלה).
const MISSING_IDENTITY_WHERE = `kind = 'escalation' AND (item_id IS NULL OR item_source IS NULL)`;

const candidatesStmt = db.prepare(
  `SELECT id, user_key, finding_key, item_id, item_source
     FROM notifications
    WHERE ${MISSING_IDENTITY_WHERE}
    ORDER BY id ASC`,
);

const updateStmt = db.prepare(
  `UPDATE notifications
      SET item_id = ?, item_source = ?, context_json = ?
    WHERE id = ? AND ${MISSING_IDENTITY_WHERE}`,
);

export interface Classification {
  safe: { row: CandidateRow; finding: StoredFinding }[];
  skippedNoIdentity: { row: CandidateRow; finding: StoredFinding }[];
  orphan: CandidateRow[];
}

export function classify(candidates: CandidateRow[], byKey: Map<string, StoredFinding>): Classification {
  const safe: Classification["safe"] = [];
  const skippedNoIdentity: Classification["skippedNoIdentity"] = [];
  const orphan: CandidateRow[] = [];
  for (const row of candidates) {
    const finding = row.finding_key ? byKey.get(row.finding_key) : undefined;
    if (!finding) {
      orphan.push(row);
      continue;
    }
    if (finding.itemId && finding.itemSource) safe.push({ row, finding });
    else skippedNoIdentity.push({ row, finding });
  }
  return { safe, skippedNoIdentity, orphan };
}

function report(candidates: CandidateRow[], c: Classification, apply: boolean): void {
  logger.info(`מצב: ${apply ? "APPLY — כתיבה בפועל" : "DRY-RUN — בלי כתיבה"}`);
  logger.info(`candidates (escalation, חסרות item_id/item_source): ${candidates.length}`);
  logger.info(`  safe (יש finding פעיל עם itemId+itemSource): ${c.safe.length}`);
  logger.info(`  skipped-no-identity (finding קיים אבל בלי זהות — לא נוגעים): ${c.skippedNoIdentity.length}`);
  logger.info(`  orphan (אין finding פעיל תואם — לא נוגעים): ${c.orphan.length}`);

  if (c.safe.length) {
    logger.info("\nIDs שעתידים להתעדכן (safe):");
    for (const { row, finding } of c.safe) {
      logger.info(
        `  #${row.id} | ${row.finding_key} | user=${row.user_key} -> itemId=${finding.itemId} itemSource=${finding.itemSource}`,
      );
    }
  }
  if (c.skippedNoIdentity.length) {
    logger.info("\nskipped-no-identity:");
    for (const { row, finding } of c.skippedNoIdentity) {
      logger.info(`  #${row.id} | ${row.finding_key} | user=${row.user_key} | finding.kind=${finding.kind}`);
    }
  }
  if (c.orphan.length) {
    logger.info("\norphan:");
    for (const row of c.orphan) {
      logger.info(`  #${row.id} | ${row.finding_key ?? "-"} | user=${row.user_key}`);
    }
  }
}

export interface BackfillResult extends Classification {
  candidates: CandidateRow[];
  applied: boolean;
  updated: number;
}

/** הליבה — משמש גם את ה-CLI (למטה) וגם את הבדיקה (test-backfill-escalation-identity.ts), כדי
 *  שהבדיקה תפעיל את אותו קוד בדיוק שרץ בפרודקשן, לא עותק מקביל. */
export function runBackfill(apply: boolean, { silent = false }: { silent?: boolean } = {}): BackfillResult {
  const byKey = new Map(listActiveFindings().map((f) => [f.findingKey, f]));
  const candidates = candidatesStmt.all() as unknown as CandidateRow[];
  const c = classify(candidates, byKey);

  if (!silent) report(candidates, c, apply);

  if (!apply) {
    if (!silent) logger.info("\nDRY-RUN בלבד — שום דבר לא נכתב. הרץ עם --apply כדי לבצע בפועל.");
    return { ...c, candidates, applied: false, updated: 0 };
  }

  let updated = 0;
  for (const { row, finding } of c.safe) {
    const ctx = escalationNotifContext(finding);
    const info = updateStmt.run(ctx.itemId ?? null, ctx.itemSource ?? null, JSON.stringify(ctx.context), row.id);
    if (Number(info.changes) > 0) updated++;
  }
  if (!silent) logger.info(`\n✅ עודכנו ${updated} / ${c.safe.length} שורות safe (מתוך ${candidates.length} candidates).`);
  return { ...c, candidates, applied: true, updated };
}

// רץ אוטומטית רק כשהקובץ מופעל ישירות (npm run maintenance:backfill-escalations[:apply]) — לא
// כש-test-backfill-escalation-identity.ts מייבא ממנו runBackfill/classify.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBackfill(APPLY);
}
