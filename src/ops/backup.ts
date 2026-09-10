/**
 * גיבוי יומי של בסיס הנתונים (SQLite).
 *
 * `VACUUM INTO` מייצר עותק עקבי ודחוס תוך כדי ריצה — לא צריך לעצור את המערכת ולא מושפע מ-WAL.
 * הגיבויים נשמרים ב-data/backups/ (מחוץ ל-git), 14 האחרונים. בשרת — rsync/restic לילי מעבירים
 * את התיקייה הזו ליעד חיצוני (ראה docs/deployment-hetzner.md).
 */

import fs from "node:fs";
import { db } from "../db/db.js";
import { logger } from "../utils/logger.js";

const BACKUP_DIR = "data/backups";
const KEEP = 14;
const NAME_RE = /^agent-\d{4}-\d{2}-\d{2}\.db$/;

export interface BackupResult {
  file: string;
  bytes: number;
  pruned: number;
}

export function runDbBackup(): BackupResult {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = `${BACKUP_DIR}/agent-${stamp}.db`;

  // אם כבר יש גיבוי מהיום — דורסים אותו (הגיבוי האחרון של היום מנצח).
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  // ניקוי — שומרים רק את KEEP האחרונים לפי שם (התאריך בשם ממיין כרונולוגית).
  const existing = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => NAME_RE.test(f))
    .sort();
  let pruned = 0;
  for (const old of existing.slice(0, Math.max(0, existing.length - KEEP))) {
    fs.rmSync(`${BACKUP_DIR}/${old}`, { force: true });
    pruned++;
  }

  const bytes = fs.statSync(file).size;
  logger.info({ file, kb: Math.round(bytes / 1024), pruned }, "גיבוי DB נוצר");
  return { file, bytes, pruned };
}

/** התאריך (YYYY-MM-DD) של הגיבוי האחרון הקיים, או null אם אין. ל-/health. */
export function lastBackupDate(): string | null {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => NAME_RE.test(f))
    .sort();
  const last = files[files.length - 1];
  return last ? last.slice("agent-".length, "agent-".length + 10) : null;
}
