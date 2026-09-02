import { db } from "../db.js";

export interface PendingAction {
  id: number;
  jid: string;
  toolName: string;
  toolInput: string;
  draftText: string;
  status: "pending" | "confirmed" | "cancelled";
  createdAt: string;
}

interface PendingActionRow {
  id: number;
  jid: string;
  tool_name: string;
  tool_input: string;
  draft_text: string;
  status: string;
  created_at: string;
}

const insertStmt = db.prepare(
  `INSERT INTO pending_actions (jid, tool_name, tool_input, draft_text) VALUES (?, ?, ?, ?)`,
);
const getOpenStmt = db.prepare(
  `SELECT * FROM pending_actions WHERE jid = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`,
);
const updateStatusStmt = db.prepare(`UPDATE pending_actions SET status = ? WHERE id = ?`);

function fromRow(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    jid: row.jid,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    draftText: row.draft_text,
    status: row.status as PendingAction["status"],
    createdAt: row.created_at,
  };
}

export function createPendingAction(jid: string, toolName: string, toolInput: unknown, draftText: string): number {
  const result = insertStmt.run(jid, toolName, JSON.stringify(toolInput), draftText);
  return Number(result.lastInsertRowid);
}

export function getOpenPendingAction(jid: string): PendingAction | undefined {
  const row = getOpenStmt.get(jid) as PendingActionRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function resolvePendingAction(id: number, status: "confirmed" | "cancelled") {
  updateStatusStmt.run(status, id);
}
