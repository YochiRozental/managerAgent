import { db } from "../db.js";

export interface ChatRow {
  id: number;
  role: "user" | "assistant" | "break";
  content: string;
  actions: string[];
  createdAt: string;
}

interface Row {
  id: number;
  role: string;
  content: string;
  actions: string | null;
  created_at: string;
}

const insertStmt = db.prepare(
  `INSERT INTO chat_messages (user_key, role, content, actions) VALUES (?, ?, ?, ?)`,
);
const recentStmt = db.prepare(
  `SELECT id, role, content, actions, created_at FROM chat_messages WHERE user_key = ? ORDER BY id DESC LIMIT ?`,
);
const clearStmt = db.prepare(`DELETE FROM chat_messages WHERE user_key = ?`);

function fromRow(r: Row): ChatRow {
  return {
    id: r.id,
    role: r.role as ChatRow["role"],
    content: r.content,
    actions: r.actions ? (JSON.parse(r.actions) as string[]) : [],
    createdAt: r.created_at,
  };
}

/** מוסיף זוג הודעה+תשובה מסבב שיחה. */
export function appendChatTurn(userKey: string, userMsg: string, assistantMsg: string, actions: string[]): void {
  insertStmt.run(userKey, "user", userMsg, null);
  insertStmt.run(userKey, "assistant", assistantMsg, actions.length ? JSON.stringify(actions) : null);
}

/** מפריד "שיחה חדשה" — ההיסטוריה נשמרת, רק ההקשר של המודל מתאפס. */
export function addChatBreak(userKey: string): void {
  insertStmt.run(userKey, "break", "", null);
}

/** ההודעות האחרונות (עד limit), בסדר כרונולוגי. */
export function getChatHistory(userKey: string, limit = 120): ChatRow[] {
  return (recentStmt.all(userKey, limit) as unknown as Row[]).map(fromRow).reverse();
}

export function clearChatHistory(userKey: string): void {
  clearStmt.run(userKey);
}
