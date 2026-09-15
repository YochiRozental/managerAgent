import { db } from "../db.js";

/**
 * היסטוריית שיחה על בקשת אישור — append-only, לא שדה יחיד שנדרס. ראה CLAUDE.md / audit 2026-09-14:
 * "מוטי שואל → עובד עונה → מוטי שואל שוב → עובד עונה" — כל הודעה נשמרת בנפרד, לפי סדר.
 */

export type ApprovalMessageSenderRole = "manager" | "employee";

export interface StoredApprovalMessage {
  id: number;
  approvalId: number;
  senderUserKey: string;
  senderRole: ApprovalMessageSenderRole;
  message: string;
  createdAt: string;
}

interface Row {
  id: number;
  approval_id: number;
  sender_user_key: string;
  sender_role: string;
  message: string;
  created_at: string;
}

function fromRow(r: Row): StoredApprovalMessage {
  return {
    id: r.id,
    approvalId: r.approval_id,
    senderUserKey: r.sender_user_key,
    senderRole: r.sender_role as ApprovalMessageSenderRole,
    message: r.message,
    createdAt: r.created_at,
  };
}

const insertStmt = db.prepare(
  `INSERT INTO manager_approval_messages (approval_id, sender_user_key, sender_role, message) VALUES (?, ?, ?, ?)`,
);
const getStmt = db.prepare(`SELECT * FROM manager_approval_messages WHERE id = ?`);
const listStmt = db.prepare(`SELECT * FROM manager_approval_messages WHERE approval_id = ? ORDER BY id ASC`);

export function addApprovalMessage(
  approvalId: number,
  senderUserKey: string,
  senderRole: ApprovalMessageSenderRole,
  message: string,
): StoredApprovalMessage {
  const info = insertStmt.run(approvalId, senderUserKey, senderRole, message);
  return fromRow(getStmt.get(Number(info.lastInsertRowid)) as unknown as Row);
}

export function listApprovalMessages(approvalId: number): StoredApprovalMessage[] {
  return (listStmt.all(approvalId) as unknown as Row[]).map(fromRow);
}
