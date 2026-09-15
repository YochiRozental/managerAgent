/**
 * בדיקה ממוקדת (audit 2026-09-15): upsertFinding.touchStmt לא רענן item_id/item_source על ממצא
 * קיים — 92 מתוך 93 findings בפועל היו תקועים עם item_id=NULL, כולל findings ברמת משימה
 * (stuck/overdue_stale) שכן אמורים לשאת זהות. תוקן ל-COALESCE(new, existing): "ריפוי" בלי לדרוס
 * ערך תקין קיים בערך חדש שחסר, ועדיין מתעדכן כשמגיע ערך חדש שונה. due_date נבדק בנפרד ונשאר ללא
 * שינוי (מתעדכן ללא תנאי בכל upsert — בכוונה, "הערך הנוכחי מהסריקה האחרונה").
 * DB מקומי אמיתי, אפס Monday.
 *
 *   npm run test:finding-identity
 */

import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const MARK = "__id_heal_test__";

function cleanup(): void {
  db.exec(`DELETE FROM control_findings WHERE finding_key LIKE '${MARK}%'`);
}
cleanup();

const now = () => new Date().toISOString();
const base = {
  kind: "overdue_stale",
  severity: "high",
  who: "דוב שפירא",
  project: "בדיקת ריפוי זהות",
  headline: "בדיקה: משימה לדוגמה",
  detail: "פרטים",
};

function main(): void {
  // --- תרחיש 1: ממצא ישן בלי זהות מקבל אותה ב-upsert הבא (ריפוי) ---
  const fk1 = `${MARK}:heal`;
  const first = upsertFinding({ findingKey: fk1, ...base, now: now() }); // בלי itemId — כמו ממצא ישן טרום-זהות
  check("שלב 1: ממצא נוצר בלי זהות", first.itemId === null && first.itemSource === null, JSON.stringify(first));

  const healed = upsertFinding({ findingKey: fk1, ...base, itemId: "it-A", itemSource: "general", now: now() });
  check("שלב 2: ריפוי — itemId מתעדכן על ממצא קיים", healed.itemId === "it-A", `קיבל: ${healed.itemId}`);
  check("שלב 2: ריפוי — itemSource מתעדכן על ממצא קיים", healed.itemSource === "general", `קיבל: ${healed.itemSource}`);

  // --- תרחיש 2: זהות קיימת לא נמחקת כש-upsert מאוחר מגיע בלי זהות (למשל bug זמני/finding אחר) ---
  const notLost = upsertFinding({ findingKey: fk1, ...base, headline: "בדיקה: כותרת התעדכנה", now: now() }); // בלי itemId/itemSource
  check(
    "שלב 3: upsert בלי itemId לא מוחק זהות קיימת (itemId)",
    notLost.itemId === "it-A",
    `קיבל: ${notLost.itemId}`,
  );
  check(
    "שלב 3: upsert בלי itemSource לא מוחק זהות קיימת (itemSource)",
    notLost.itemSource === "general",
    `קיבל: ${notLost.itemSource}`,
  );
  check("שלב 3: שדות אחרים (headline) כן מתעדכנים כרגיל", notLost.headline === "בדיקה: כותרת התעדכנה");

  // --- תרחיש 3: זהות קיימת מתעדכנת כשמגיע ערך תקין חדש (שונה) ---
  const updated = upsertFinding({ findingKey: fk1, ...base, itemId: "it-B", itemSource: "project_stage", now: now() });
  check("שלב 4: itemId מתעדכן לערך חדש שונה", updated.itemId === "it-B", `קיבל: ${updated.itemId}`);
  check("שלב 4: itemSource מתעדכן לערך חדש שונה", updated.itemSource === "project_stage", `קיבל: ${updated.itemSource}`);

  // --- תרחיש 4: due_date — לא נגעתי (מתעדכן ללא תנאי, בכוונה: "הערך הנוכחי מהסריקה האחרונה") ---
  const fk2 = `${MARK}:duedate`;
  const d1 = upsertFinding({ findingKey: fk2, ...base, dueDate: "2026-09-20", now: now() });
  check("due_date: נשמר ביצירה", d1.dueDate === "2026-09-20", `קיבל: ${d1.dueDate}`);

  const d2 = upsertFinding({ findingKey: fk2, ...base, now: now() }); // בלי dueDate בכלל
  check(
    "due_date: מתאפס ל-null כש-upsert הבא מגיע בלי dueDate (ללא COALESCE — בכוונה, לא bug)",
    d2.dueDate === null,
    `קיבל: ${d2.dueDate}`,
  );

  const d3 = upsertFinding({ findingKey: fk2, ...base, dueDate: "2026-09-25", now: now() });
  check("due_date: מתעדכן שוב לערך חדש", d3.dueDate === "2026-09-25", `קיבל: ${d3.dueDate}`);

  // --- תרחיש 5: ממצא שלגיטימית אין לו זהות (project-level/CRM) — לא ממציאים לו אחת אף פעם ---
  const fk3 = `${MARK}:no-identity`;
  const nA = upsertFinding({ findingKey: fk3, kind: "project_stuck", severity: "high", who: "מוטי", headline: "פרויקט תקוע לדוגמה", detail: "—", now: now() });
  check("ממצא ברמת פרויקט: נוצר בלי itemId (לגיטימי)", nA.itemId === null);
  const nB = upsertFinding({ findingKey: fk3, kind: "project_stuck", severity: "high", who: "מוטי", headline: "פרויקט תקוע לדוגמה — עדכון", detail: "—", now: now() });
  check("ממצא ברמת פרויקט: נשאר בלי itemId גם אחרי touch נוסף (לא מומצא)", nB.itemId === null);

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
  logger.error(err, "test-finding-identity-healing failed");
  process.exit(1);
}
