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
  | "manager_pinged"
  /** Policy Engine קבע שהפעולה שהעובד ביקש דורשת אישור מוטי — לא בוצע שינוי ב-Monday. */
  | "manager_approval_required"
  /** מוטי אישר בקשה שהמתינה לאישור (approvalActions.ts) — הפעולה בוצעה בפועל ב-Monday. */
  | "manager_approval_approved"
  /** מוטי דחה בקשה שהמתינה לאישור — שום שינוי ב-Monday, הממצא נשאר פתוח. */
  | "manager_approval_rejected";

export interface FindingEventPayload {
  snoozeUntil?: string; // YYYY-MM-DD
  note?: string;
  byUser?: string;
  action?: string;
  /** ל-manager_approval_required — payload מובנה מה-Policy Engine להמשך טיפול (ManagerApprovalPayload). */
  details?: unknown;
  /** ל-snoozed שעבר דרך Policy Engine (replyDefer) — תיעוד מלא של בקשת הדחייה. */
  itemId?: string;
  itemSource?: string;
  oldDueDate?: string | null;
  wasOverdue?: boolean;
  /** מקשר בין אירוע הממצא לבקשת האישור ב-manager_approvals. */
  approvalId?: number;
  /**
   * scope change (audit 2026-09-18/19): metadata לתיעוד/audit בלבד — מסמן שהדחייה (snoozed) נבעה
   * משינוי/הרחבת היקף העבודה. לא נקרא בשום מקום שמשפיע על החלטה — רק נשמר. ר' loopReply.replyDefer.
   */
  scopeChange?: boolean;
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
   WHERE finding_key = ? AND event IN
     ('employee_responded','manager_pinged','snoozed','manager_approval_required',
      'manager_approval_approved','manager_approval_rejected')
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

// ---- לסיכום סוף היום (eodSummary.ts) ----

export interface DeferralSinceRecord {
  createdAt: string;
  findingKey: string;
  itemId: string | null;
  itemSource: string | null;
  headline: string;
  who: string;
  project: string | null;
  byUserKey: string | null;
  snoozeUntil: string | null;
  note: string | null;
  scopeChange: boolean;
}

interface DeferralSinceRow {
  created_at: string;
  finding_key: string;
  payload_json: string | null;
  item_id: string | null;
  item_source: string | null;
  headline: string;
  who: string;
  project: string | null;
}

// JOIN עם control_findings (אותו pattern כמו deferralHistory.ts) — finding_events בלבד לא נושא
// שם משימה/פרויקט קריא. sinceIso בפורמט SQL UTC ("YYYY-MM-DD HH:MM:SS") — created_at הוא
// datetime('now'), לא ISO עם offset (בניגוד ל-control_findings.first_seen/resolved_at).
const deferralsSinceStmt = db.prepare(`
  SELECT fe.created_at AS created_at, fe.finding_key AS finding_key, fe.payload_json AS payload_json,
         cf.item_id AS item_id, cf.item_source AS item_source, cf.headline AS headline, cf.who AS who, cf.project AS project
  FROM finding_events fe
  JOIN control_findings cf ON cf.finding_key = fe.finding_key
  WHERE fe.event = 'snoozed' AND fe.created_at >= ?
  ORDER BY fe.id ASC
`);

/** כל בקשות הדחייה (snoozed) שנרשמו מ-sinceIso ואילך, עם context קריא (שם/משימה/פרויקט) לסיכום סוף יום. */
export function deferralEventsSince(sinceIso: string): DeferralSinceRecord[] {
  const rows = deferralsSinceStmt.all(sinceIso) as unknown as DeferralSinceRow[];
  return rows.map((r) => {
    const payload = r.payload_json ? (JSON.parse(r.payload_json) as FindingEventPayload) : {};
    return {
      createdAt: r.created_at,
      findingKey: r.finding_key,
      itemId: r.item_id,
      itemSource: r.item_source,
      headline: r.headline,
      who: r.who,
      project: r.project,
      byUserKey: payload.byUser ?? null,
      snoozeUntil: payload.snoozeUntil ?? null,
      note: payload.note ?? null,
      scopeChange: !!payload.scopeChange,
    };
  });
}
