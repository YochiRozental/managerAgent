import { db } from "../db.js";

export interface ChatRow {
  role: "user" | "assistant";
  content: string;
  actions: string[];
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  startedAt: string;
  lastAt: string;
  count: number;
}

interface MsgRow {
  role: string;
  content: string;
  actions: string | null;
  created_at: string;
}
interface SessRow {
  session_id: string | null;
  title: string;
  started_at: string;
  last_at: string;
  n: number;
}

const insertStmt = db.prepare(
  `INSERT INTO chat_messages (user_key, session_id, role, content, actions) VALUES (?, ?, ?, ?, ?)`,
);
const sessionMsgsStmt = db.prepare(
  `SELECT role, content, actions, created_at FROM chat_messages
   WHERE user_key = ? AND session_id IS ? ORDER BY id ASC`,
);
const listSessionsStmt = db.prepare(
  `SELECT session_id,
          MIN(CASE WHEN role = 'user' THEN content END) AS title,
          MIN(created_at) AS started_at,
          MAX(created_at) AS last_at,
          COUNT(*) AS n
   FROM chat_messages WHERE user_key = ?
   GROUP BY session_id ORDER BY last_at DESC LIMIT 50`,
);
const latestSessionStmt = db.prepare(
  `SELECT session_id FROM chat_messages WHERE user_key = ? ORDER BY id DESC LIMIT 1`,
);
const clearStmt = db.prepare(`DELETE FROM chat_messages WHERE user_key = ?`);
const deleteSessionStmt = db.prepare(`DELETE FROM chat_messages WHERE user_key = ? AND session_id IS ?`);

export function newSessionId(): string {
  return `s${Date.now().toString(36)}`;
}

export function appendChatTurn(
  userKey: string,
  sessionId: string,
  userMsg: string,
  assistantMsg: string,
  actions: string[],
): void {
  insertStmt.run(userKey, sessionId, "user", userMsg, null);
  insertStmt.run(userKey, sessionId, "assistant", assistantMsg, actions.length ? JSON.stringify(actions) : null);
}

export function getSessionMessages(userKey: string, sessionId: string | null): ChatRow[] {
  return (sessionMsgsStmt.all(userKey, sessionId) as unknown as MsgRow[]).map((r) => ({
    role: r.role as ChatRow["role"],
    content: r.content,
    actions: r.actions ? (JSON.parse(r.actions) as string[]) : [],
    createdAt: r.created_at,
  }));
}

export function listSessions(userKey: string): SessionSummary[] {
  return (listSessionsStmt.all(userKey) as unknown as SessRow[]).map((r) => ({
    id: r.session_id ?? "legacy",
    title: (r.title || "שיחה").slice(0, 60),
    startedAt: r.started_at,
    lastAt: r.last_at,
    count: r.n,
  }));
}

export function latestSessionId(userKey: string): string | null {
  const row = latestSessionStmt.get(userKey) as { session_id: string | null } | undefined;
  return row?.session_id ?? null;
}

export function clearChatHistory(userKey: string): void {
  clearStmt.run(userKey);
}

export function deleteSession(userKey: string, sessionId: string | null): void {
  deleteSessionStmt.run(userKey, sessionId);
}
