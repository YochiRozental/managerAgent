import { db } from "../db.js";

export interface OutboxMessage {
  id: number;
  jid: string;
  body: string;
  createdAt: string;
}

interface Row {
  id: number;
  jid: string;
  body: string;
  created_at: string;
}

const insertStmt = db.prepare(`INSERT INTO whatsapp_outbox (jid, body) VALUES (?, ?)`);
const listUnsentStmt = db.prepare(
  `SELECT id, jid, body, created_at FROM whatsapp_outbox WHERE sent_at IS NULL ORDER BY id ASC LIMIT 20`,
);
const markSentStmt = db.prepare(`UPDATE whatsapp_outbox SET sent_at = datetime('now') WHERE id = ?`);
// ניקוי הודעות ישנות שלא נשלחו (סוכן ה-WhatsApp היה כבוי שעות) — לא מציפים אותו כשהוא חוזר.
const dropOldStmt = db.prepare(
  `UPDATE whatsapp_outbox SET sent_at = datetime('now') WHERE sent_at IS NULL AND created_at < datetime('now', '-12 hours')`,
);

const supersedeStmt = db.prepare(
  `UPDATE whatsapp_outbox SET sent_at = datetime('now') WHERE jid = ? AND sent_at IS NULL`,
);

/**
 * enqueue שמחליף הודעות קודמות שטרם נשלחו לאותו נמען — לתדריך/דוח שיוצא פעם ביום,
 * כדי שאם הסוכן היה כבוי כמה סבבים, הנמען יקבל רק את הגרסה האחרונה.
 */
export function enqueueWhatsapp(jid: string, body: string, supersede = false): void {
  if (supersede) supersedeStmt.run(jid);
  insertStmt.run(jid, body);
}

export function listUnsentWhatsapp(): OutboxMessage[] {
  dropOldStmt.run();
  return (listUnsentStmt.all() as unknown as Row[]).map((r) => ({
    id: r.id,
    jid: r.jid,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export function markWhatsappSent(id: number): void {
  markSentStmt.run(id);
}
