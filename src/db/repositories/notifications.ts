import { db } from "../db.js";

export interface Notification {
  id: number;
  userKey: string;
  kind: string;
  body: string;
  findingKey: string | null;
  itemId: string | null;
  itemSource: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
  seenAt: string | null;
}

interface Row {
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
}

function fromRow(r: Row): Notification {
  return {
    id: r.id,
    userKey: r.user_key,
    kind: r.kind,
    body: r.body,
    findingKey: r.finding_key,
    itemId: r.item_id,
    itemSource: r.item_source,
    context: r.context_json ? (JSON.parse(r.context_json) as Record<string, unknown>) : null,
    createdAt: r.created_at,
    seenAt: r.seen_at,
  };
}

const insertStmt = db.prepare(
  `INSERT INTO notifications (user_key, kind, body, finding_key, item_id, item_source, context_json)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
// הפנייה היזומה ("nudge") מוצגת כבועת צ'אט, לא בחלונית ההתראות — כדי לא להציג פעמיים.
const listUnseenStmt = db.prepare(
  `SELECT * FROM notifications WHERE user_key = ? AND seen_at IS NULL AND kind != 'nudge' ORDER BY id ASC`,
);
const listUnseenNudgesStmt = db.prepare(
  `SELECT * FROM notifications WHERE user_key = ? AND seen_at IS NULL AND kind = 'nudge' ORDER BY id ASC`,
);
const markSeenStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now') WHERE user_key = ? AND seen_at IS NULL AND kind != 'nudge'`,
);
const markNudgeSeenStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now') WHERE id = ? AND seen_at IS NULL`,
);
const markNudgesForFindingStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now')
   WHERE user_key = ? AND finding_key = ? AND kind = 'nudge' AND seen_at IS NULL`,
);
// דה-דופ: אותה תזכורת על אותו ממצא לאותו אדם, שעדיין לא נראתה — לא לשכפל.
const existsUnseenStmt = db.prepare(
  `SELECT 1 FROM notifications WHERE user_key = ? AND finding_key = ? AND kind = ? AND seen_at IS NULL LIMIT 1`,
);

export interface NotificationContext {
  itemId?: string;
  itemSource?: string;
  context?: Record<string, unknown>;
}

export function addNotification(
  userKey: string,
  kind: string,
  body: string,
  findingKey?: string,
  ctx: NotificationContext = {},
): void {
  if (findingKey && existsUnseenStmt.get(userKey, findingKey, kind)) return;
  insertStmt.run(
    userKey,
    kind,
    body,
    findingKey ?? null,
    ctx.itemId ?? null,
    ctx.itemSource ?? null,
    ctx.context ? JSON.stringify(ctx.context) : null,
  );
}

export function listUnseenNotifications(userKey: string): Notification[] {
  return (listUnseenStmt.all(userKey) as unknown as Row[]).map(fromRow);
}

export function markNotificationsSeen(userKey: string): void {
  markSeenStmt.run(userKey);
}

/** פניות יזומות פתוחות של העובד — מוצגות כבועות צ'אט, וה-brief שלהן מוזרק לתשובה. */
export function listUnseenNudges(userKey: string): Notification[] {
  return (listUnseenNudgesStmt.all(userKey) as unknown as Row[]).map(fromRow);
}

export function markNudgeSeen(id: number): void {
  markNudgeSeenStmt.run(id);
}

/** אחרי שהעובד ענה וטופל הממצא — סוגרים את כל הנודג'ים הפתוחים עליו. */
export function markNudgesSeenForFinding(userKey: string, findingKey: string): void {
  markNudgesForFindingStmt.run(userKey, findingKey);
}

const clearKindStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now') WHERE user_key = ? AND kind = ? AND seen_at IS NULL`,
);
/** מסמן כנקרא הודעות קודמות מאותו סוג — לתדריך הבוקר, שמחליף את של אתמול. */
export function supersedeKind(userKey: string, kind: string): void {
  clearKindStmt.run(userKey, kind);
}
