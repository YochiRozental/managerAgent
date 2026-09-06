import { db } from "../db.js";

export interface Commitment {
  id: number;
  createdBy: string;
  toWhom: string;
  what: string;
  dueDate: string | null;
  project: string | null;
  status: "open" | "done" | "cancelled";
  createdAt: string;
  closedAt: string | null;
}

interface Row {
  id: number;
  created_by: string;
  to_whom: string;
  what: string;
  due_date: string | null;
  project: string | null;
  status: string;
  created_at: string;
  closed_at: string | null;
}

function fromRow(r: Row): Commitment {
  return {
    id: r.id,
    createdBy: r.created_by,
    toWhom: r.to_whom,
    what: r.what,
    dueDate: r.due_date,
    project: r.project,
    status: r.status as Commitment["status"],
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}

const insertStmt = db.prepare(
  `INSERT INTO commitments (created_by, to_whom, what, due_date, project) VALUES (?, ?, ?, ?, ?)`,
);
const listOpenStmt = db.prepare(
  `SELECT * FROM commitments WHERE status = 'open' ORDER BY (due_date IS NULL), due_date ASC`,
);
const listByUserStmt = db.prepare(
  `SELECT * FROM commitments WHERE status = 'open' AND created_by = ? ORDER BY (due_date IS NULL), due_date ASC`,
);
const getStmt = db.prepare(`SELECT * FROM commitments WHERE id = ?`);
const closeStmt = db.prepare(`UPDATE commitments SET status = ?, closed_at = datetime('now') WHERE id = ?`);

export function addCommitment(input: {
  createdBy: string;
  toWhom: string;
  what: string;
  dueDate?: string;
  project?: string;
}): Commitment {
  const res = insertStmt.run(
    input.createdBy,
    input.toWhom,
    input.what,
    input.dueDate ?? null,
    input.project ?? null,
  );
  return fromRow(getStmt.get(Number(res.lastInsertRowid)) as unknown as Row);
}

export function listOpenCommitments(): Commitment[] {
  return (listOpenStmt.all() as unknown as Row[]).map(fromRow);
}

export function listUserCommitments(userKey: string): Commitment[] {
  return (listByUserStmt.all(userKey) as unknown as Row[]).map(fromRow);
}

export function closeCommitment(id: number, status: "done" | "cancelled"): boolean {
  const row = getStmt.get(id) as unknown as Row | undefined;
  if (!row || row.status !== "open") return false;
  closeStmt.run(status, id);
  return true;
}
