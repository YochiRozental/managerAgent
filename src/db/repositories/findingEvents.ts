import { db } from "../db.js";

/**
 * אירועים על ממצא בקרה — הצד השני של הלולאה: לא רק "הסריקה עדיין רואה את הבעיה", אלא גם
 * "העובד הגיב", "נדחה ל-15/9 לבקשתו", "נסגר כי דיווח שסיים", "המנהל עודכן".
 *
 * escalation.ts קורא מכאן כדי:
 *   • לא להסלים ממצא שנדחה (snoozed) עד תאריך עתידי
 *   • לאפס את שעון ה-staleness אחרי תגובה של העובד (employee_responded / manager_pinged)
 *   • לדלג על ממצא שנסגר בעקבות תשובה (resolved_by_reply)
 */

export type FindingEvent =
  | "nudge_sent"
  | "employee_responded"
  | "snoozed"
  | "resolved_by_reply"
  | "manager_pinged";

export interface FindingEventPayload {
  snoozeUntil?: string; // YYYY-MM-DD
  note?: string;
  byUser?: string;
  action?: string;
}

interface Row {
  id: number;
  finding_key: string;
  event: string;
  payload_json: string | null;
  created_at: string;
}

export interface StoredFindingEvent {
  id: number;
  findingKey: string;
  event: FindingEvent;
  payload: FindingEventPayload;
  createdAt: string;
}

function fromRow(r: Row): StoredFindingEvent {
  return {
    id: r.id,
    findingKey: r.finding_key,
    event: r.event as FindingEvent,
    payload: r.payload_json ? (JSON.parse(r.payload_json) as FindingEventPayload) : {},
    createdAt: r.created_at,
  };
}

const insertStmt = db.prepare(
  `INSERT INTO finding_events (finding_key, event, payload_json) VALUES (?, ?, ?)`,
);
const lastByEventStmt = db.prepare(
  `SELECT * FROM finding_events WHERE finding_key = ? AND event = ? ORDER BY id DESC LIMIT 1`,
);
const allForKeyStmt = db.prepare(
  `SELECT * FROM finding_events WHERE finding_key = ? ORDER BY id ASC`,
);
const lastResponseStmt = db.prepare(
  `SELECT * FROM finding_events
   WHERE finding_key = ? AND event IN ('employee_responded','manager_pinged','snoozed')
   ORDER BY id DESC LIMIT 1`,
);

export function recordFindingEvent(
  findingKey: string,
  event: FindingEvent,
  payload: FindingEventPayload = {},
): void {
  insertStmt.run(findingKey, event, Object.keys(payload).length ? JSON.stringify(payload) : null);
}

export function lastFindingEvent(findingKey: string, event: FindingEvent): StoredFindingEvent | null {
  const r = lastByEventStmt.get(findingKey, event) as unknown as Row | undefined;
  return r ? fromRow(r) : null;
}

export function findingEvents(findingKey: string): StoredFindingEvent[] {
  return (allForKeyStmt.all(findingKey) as unknown as Row[]).map(fromRow);
}

/** התאריך (YYYY-MM-DD) שעד אליו הממצא "שקט" לבקשת העובד, או null. הדחייה האחרונה מנצחת. */
export function snoozedUntil(findingKey: string): string | null {
  const ev = lastFindingEvent(findingKey, "snoozed");
  return ev?.payload.snoozeUntil ?? null;
}

/** האם הממצא כבר נסגר בעקבות תשובת עובד (סיים / לא רלוונטי). */
export function isResolvedByReply(findingKey: string): boolean {
  return !!lastFindingEvent(findingKey, "resolved_by_reply");
}

/**
 * המועד האחרון שבו "קרה משהו" מצד העובד/המנהל — תגובה, דחייה, או עדכון למנהל.
 * escalation מתחיל לספור staleness מחדש מכאן במקום מ-first_seen.
 */
export function lastResponseAt(findingKey: string): string | null {
  const r = lastResponseStmt.get(findingKey) as unknown as Row | undefined;
  return r?.created_at ?? null;
}
