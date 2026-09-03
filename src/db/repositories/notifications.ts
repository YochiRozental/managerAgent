import { db } from "../db.js";

export interface Notification {
  id: number;
  userKey: string;
  kind: string;
  body: string;
  findingKey: string | null;
  createdAt: string;
  seenAt: string | null;
}

interface Row {
  id: number;
  user_key: string;
  kind: string;
  body: string;
  finding_key: string | null;
  created_at: string;
  seen_at: string | null;
}

function fromRow(r: Row): Notification {
  return {
    id: r.id,
    userKey: r.user_key,
    kind: r.kind,
    body: r.body,
    findingKey: r.finding_key,
    createdAt: r.created_at,
    seenAt: r.seen_at,
  };
}

const insertStmt = db.prepare(
  `INSERT INTO notifications (user_key, kind, body, finding_key) VALUES (?, ?, ?, ?)`,
);
const listUnseenStmt = db.prepare(
  `SELECT * FROM notifications WHERE user_key = ? AND seen_at IS NULL ORDER BY id ASC`,
);
const markSeenStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now') WHERE user_key = ? AND seen_at IS NULL`,
);
// דה-דופ: אותה תזכורת על אותו ממצא לאותו אדם, שעדיין לא נראתה — לא לשכפל.
const existsUnseenStmt = db.prepare(
  `SELECT 1 FROM notifications WHERE user_key = ? AND finding_key = ? AND kind = ? AND seen_at IS NULL LIMIT 1`,
);

export function addNotification(
  userKey: string,
  kind: string,
  body: string,
  findingKey?: string,
): void {
  if (findingKey && existsUnseenStmt.get(userKey, findingKey, kind)) return;
  insertStmt.run(userKey, kind, body, findingKey ?? null);
}

export function listUnseenNotifications(userKey: string): Notification[] {
  return (listUnseenStmt.all(userKey) as unknown as Row[]).map(fromRow);
}

export function markNotificationsSeen(userKey: string): void {
  markSeenStmt.run(userKey);
}

const clearKindStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now') WHERE user_key = ? AND kind = ? AND seen_at IS NULL`,
);
/** מסמן כנקרא הודעות קודמות מאותו סוג — לתדריך הבוקר, שמחליף את של אתמול. */
export function supersedeKind(userKey: string, kind: string): void {
  clearKindStmt.run(userKey, kind);
}
