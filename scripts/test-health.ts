/**
 * בדיקות Phase 1a — יציבות ברקע: heartbeats, job_runs, גיבוי DB, /health, catch-up.
 * לא נוגע ב-Monday/AI. משתמש ב-data/agent.db האמיתי אבל רק בשורות סימן (job='__test__')
 * ובפעימות לב שהוא מנקה בסוף. הרצה: npm run test:health
 */

import "dotenv/config";
import fs from "node:fs";
import { db } from "../src/db/db.js";
import {
  finishJobRun,
  jobRunCountOn,
  lastJobRun,
  lastSuccessfulJobRun,
  listHeartbeats,
  recordHeartbeat,
  startJobRun,
} from "../src/db/repositories/systemHealth.js";
import { lastBackupDate, runDbBackup } from "../src/ops/backup.js";
import { getHealth, noteIncident } from "../src/ops/health.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}`);
    failed++;
  }
}

// --- WAL ---
const jm = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
check("DB במצב WAL", jm.journal_mode === "wal");
const bt = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
check("busy_timeout = 5000", bt.timeout === 5000);

// --- backup ---
const bk = runDbBackup();
check("קובץ הגיבוי נוצר", fs.existsSync(bk.file));
const probe = new (await import("node:sqlite")).DatabaseSync(bk.file);
const cnt = probe.prepare("SELECT COUNT(*) c FROM control_findings").get() as { c: number };
probe.close();
check("הגיבוי הוא SQLite תקין עם הסכימה", typeof cnt.c === "number");
check("lastBackupDate מחזיר את התאריך של היום", lastBackupDate() === new Date().toISOString().slice(0, 10));

// --- heartbeat ---
recordHeartbeat("__test_proc__", "unit");
const hb = listHeartbeats().find((h) => h.process === "__test_proc__");
check("heartbeat נכתב ונקרא", !!hb && hb.detail === "unit");

// --- job_runs ---
const today = new Date().toISOString().slice(0, 10);
db.exec("DELETE FROM job_runs WHERE job = '__test__'");
const id = startJobRun("__test__", "manual");
check("startJobRun מחזיר id", id > 0);
check("jobRunCountOn סופר את הריצה שהותנעה", jobRunCountOn("__test__", today) === 1);
check("lastJobRun עדיין רץ (ok=null)", lastJobRun("__test__")?.ok === null);
check("אין ריצה מוצלחת עדיין", lastSuccessfulJobRun("__test__") === null);
finishJobRun(id, true);
check("finishJobRun מסמן הצלחה", lastSuccessfulJobRun("__test__")?.ok === 1);
const id2 = startJobRun("__test__", "schedule");
finishJobRun(id2, false, "בדיקה");
check("ריצה כושלת נרשמת עם error", lastJobRun("__test__")?.error === "בדיקה");
check("lastSuccessfulJobRun עדיין מצביע על ההצלחה הקודמת", lastSuccessfulJobRun("__test__")?.id === id);

// --- health: מצב תקין ---
recordHeartbeat("ops-window", "unit");
recordHeartbeat("whatsapp-agent", "unit");
const prevHour = process.env.CONTROL_SCAN_HOUR;
process.env.CONTROL_SCAN_HOUR = "23"; // דוחה את חלון "הסבב לא רץ" כדי לבדוק מצב נקי
// health.ts קורא את השעה ברמת המודול — כבר נטען. נבדוק את הלוגיקה דרך התוצאה בפועל:
const h1 = getHealth();
check(
  "health רץ ומחזיר מבנה מלא",
  typeof h1.status === "string" && Array.isArray(h1.reasons) && Array.isArray(h1.processes) && Array.isArray(h1.jobs),
);
check("שני התהליכים הנדרשים מזוהים כחיים", h1.processes.every((p) => p.alive));

// --- health: תקלה לא-מטופלת ---
noteIncident("uncaughtException", "boom");
const h2 = getHealth();
check("תקלה לאחרונה → degraded", h2.status === "degraded");
check("סיבת התקלה מופיעה", h2.reasons.some((r) => r.includes("תקלה לא-מטופלת")));

// --- health: תהליך מת ---
db.exec("UPDATE heartbeats SET beat_at = datetime('now','-10 minutes') WHERE process = 'ops-window'");
check("heartbeat ישן → התהליך לא נחשב חי", getHealth().processes.find((p) => p.name === "ops-window")?.alive === false);

// --- cleanup ---
if (prevHour === undefined) delete process.env.CONTROL_SCAN_HOUR;
else process.env.CONTROL_SCAN_HOUR = prevHour;
db.exec("DELETE FROM job_runs WHERE job = '__test__'");
db.exec("DELETE FROM heartbeats WHERE process IN ('__test_proc__','ops-window','whatsapp-agent')");

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות היציבות עברו ✅");
