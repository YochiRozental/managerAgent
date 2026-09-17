/**
 * Idempotency ליצירת פריטים מהחלונית (create_task/create_lead) — מונע כפילות אם אותו tool call
 * רץ פעמיים (timeout + retry וכו'). מפתח דטרמיניסטי מהקלט המנורמל, נשמר עם תוצאת היצירה.
 * לא נועד לפתור מירוץ אמיתי בין שתי בקשות מקבילות ממש (אותה שנייה) — רק retry עוקב.
 */

import { db } from "../db.js";

interface Row {
  result_json: string;
  created_at: string;
}

const getStmt = db.prepare(`SELECT result_json, created_at FROM idempotent_creations WHERE idempotency_key = ?`);
const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO idempotent_creations (idempotency_key, result_json) VALUES (?, ?)`,
);

export interface CachedCreation {
  result: unknown;
  createdAt: string;
}

/** תוצאה קודמת אם אותו idempotency key כבר נוצר, אחרת null. */
export function getCachedCreation(key: string): CachedCreation | null {
  const row = getStmt.get(key) as unknown as Row | undefined;
  if (!row) return null;
  return { result: JSON.parse(row.result_json), createdAt: row.created_at };
}

/** רושם תוצאת יצירה תחת המפתח. INSERT OR IGNORE — אם מישהו הקדים, לא דורסים את התוצאה שלו. */
export function recordCreation(key: string, result: unknown): void {
  insertStmt.run(key, JSON.stringify(result));
}
