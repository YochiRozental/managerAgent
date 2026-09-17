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
// nudge / approval_request / approval_instruction מוצגים ככרטיסים ייעודיים (צ'אט/כרטיס אישור),
// לא בחלונית ההתראות הגנרית — כדי לא להציג פעמיים.
const SPECIAL_KINDS = `('nudge','approval_request','approval_instruction')`;
const listUnseenStmt = db.prepare(
  `SELECT * FROM notifications WHERE user_key = ? AND seen_at IS NULL AND kind NOT IN ${SPECIAL_KINDS} ORDER BY id ASC`,
);
// approval_instruction — שאלה/הנחיה של מוטי לעובד — מוצגת לעובד בדיוק כמו נודג': בועה ייעודית
// שנשארת פתוחה עד שהוא עונה, ומזינה about (עם approvalId) להודעה הבאה שלו.
const listUnseenNudgesStmt = db.prepare(
  `SELECT * FROM notifications WHERE user_key = ? AND seen_at IS NULL AND kind IN ('nudge','approval_instruction') ORDER BY id ASC`,
);
const markSeenStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now') WHERE user_key = ? AND seen_at IS NULL AND kind NOT IN ${SPECIAL_KINDS}`,
);
const markNudgeSeenStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now') WHERE id = ? AND seen_at IS NULL`,
);
const markNudgesForFindingStmt = db.prepare(
  `UPDATE notifications SET seen_at = datetime('now')
   WHERE user_key = ? AND finding_key = ? AND kind IN ('nudge','approval_instruction') AND seen_at IS NULL`,
);
// דה-דופ: אותה תזכורת על אותו ממצא לאותו אדם, שעדיין לא נראתה — לא לשכפל. מחזיר את ה-id של
// השורה הקיימת (לא רק 1/0) כדי ש-addNotification יוכל להחזיר תמיד מזהה שמיוצג בפועל ב-DB.
const existsUnseenStmt = db.prepare(
  `SELECT id FROM notifications WHERE user_key = ? AND finding_key = ? AND kind = ? AND seen_at IS NULL LIMIT 1`,
);
// אותה שאילתה, כ-boolean — לשימוש כ-idempotency guard *מפורש* לפני שמנסים לשלוח (audit 2026-09-17,
// פנייה ראשונית ב-escalation.ts): אם קריסה/restart קרו בין addNotification ל-setEscalation
// בהרצה קודמת, ההרצה הבאה צריכה לדעת שכבר נשלח בפועל בלי להסתמך רק על escalationLevel.
const hasUnseenForKindStmt = db.prepare(
  `SELECT 1 FROM notifications WHERE user_key = ? AND finding_key = ? AND kind = ? AND seen_at IS NULL LIMIT 1`,
);
// לסיכום סוף היום (eodSummary.ts): כל ה-notifications מסוג נתון שנוצרו מ-sinceIso ואילך, לא רק
// לא-נראות — created_at הוא datetime('now') של SQLite (UTC, "YYYY-MM-DD HH:MM:SS"), אז sinceIso
// חייב להיות מפורמט באותה צורה (לא ISO עם offset) — ראה sqlUtcCutoff ב-eodSummary.ts.
const byKindSinceStmt = db.prepare(
  `SELECT * FROM notifications WHERE user_key = ? AND kind = ? AND created_at >= ? ORDER BY id ASC`,
);

export interface NotificationContext {
  itemId?: string;
  itemSource?: string;
  context?: Record<string, unknown>;
}

/** מחזיר את ה-id של הרשומה (חדשה, או קיימת אם דודופ תפס) — לשימוש כ-context.approvalId וכו'. */
export function addNotification(
  userKey: string,
  kind: string,
  body: string,
  findingKey?: string,
  ctx: NotificationContext = {},
): number {
  if (findingKey) {
    const existing = existsUnseenStmt.get(userKey, findingKey, kind) as { id: number } | undefined;
    if (existing) return existing.id;
  }
  const info = insertStmt.run(
    userKey,
    kind,
    body,
    findingKey ?? null,
    ctx.itemId ?? null,
    ctx.itemSource ?? null,
    ctx.context ? JSON.stringify(ctx.context) : null,
  );
  return Number(info.lastInsertRowid);
}

export function listUnseenNotifications(userKey: string): Notification[] {
  return (listUnseenStmt.all(userKey) as unknown as Row[]).map(fromRow);
}

/** ר' hasUnseenForKindStmt למעלה — idempotency guard מפורש, לא רק הדה-דופ הפנימי של addNotification. */
export function hasUnseenNotificationForKind(userKey: string, findingKey: string, kind: string): boolean {
  return hasUnseenForKindStmt.get(userKey, findingKey, kind) !== undefined;
}

/** ר' byKindSinceStmt למעלה — sinceIso בפורמט SQL UTC ("YYYY-MM-DD HH:MM:SS"), לא ISO עם offset. */
export function notificationsByKindSince(userKey: string, kind: string, sinceIso: string): Notification[] {
  return (byKindSinceStmt.all(userKey, kind, sinceIso) as unknown as Row[]).map(fromRow);
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
