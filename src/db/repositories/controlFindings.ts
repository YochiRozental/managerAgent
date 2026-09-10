import { db } from "../db.js";

export interface StoredFinding {
  findingKey: string;
  kind: string;
  severity: "critical" | "high" | "normal";
  who: string;
  project: string | null;
  headline: string;
  detail: string;
  url: string | null;
  itemId: string | null;
  itemSource: string | null;
  firstSeen: string;
  lastSeen: string;
  escalationLevel: number;
  lastEscalatedAt: string | null;
  resolvedAt: string | null;
}

interface Row {
  finding_key: string;
  kind: string;
  severity: string;
  who: string;
  project: string | null;
  headline: string;
  detail: string;
  url: string | null;
  item_id: string | null;
  item_source: string | null;
  first_seen: string;
  last_seen: string;
  escalation_level: number;
  last_escalated_at: string | null;
  resolved_at: string | null;
}

function fromRow(r: Row): StoredFinding {
  return {
    findingKey: r.finding_key,
    kind: r.kind,
    severity: r.severity as StoredFinding["severity"],
    who: r.who,
    project: r.project,
    headline: r.headline,
    detail: r.detail,
    url: r.url,
    itemId: r.item_id,
    itemSource: r.item_source,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    escalationLevel: r.escalation_level,
    lastEscalatedAt: r.last_escalated_at,
    resolvedAt: r.resolved_at,
  };
}

const getStmt = db.prepare(`SELECT * FROM control_findings WHERE finding_key = ?`);
const insertStmt = db.prepare(
  `INSERT INTO control_findings
     (finding_key, kind, severity, who, project, headline, detail, url, item_id, item_source, first_seen, last_seen)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const touchStmt = db.prepare(
  `UPDATE control_findings
     SET last_seen = ?, severity = ?, who = ?, headline = ?, detail = ?, url = ?, resolved_at = NULL
   WHERE finding_key = ?`,
);
const listActiveStmt = db.prepare(`SELECT * FROM control_findings WHERE resolved_at IS NULL`);
const resolveStaleStmt = db.prepare(
  `UPDATE control_findings SET resolved_at = ? WHERE resolved_at IS NULL AND last_seen < ?`,
);
const setEscalationStmt = db.prepare(
  `UPDATE control_findings SET escalation_level = ?, last_escalated_at = ? WHERE finding_key = ?`,
);

/** מוסיף ממצא חדש או מעדכן קיים (last_seen + שדות שיכולים להשתנות). מחזיר את הרשומה המעודכנת. */
export function upsertFinding(f: {
  findingKey: string;
  kind: string;
  severity: string;
  who: string;
  project?: string;
  headline: string;
  detail: string;
  url?: string;
  itemId?: string;
  itemSource?: string;
  now: string;
}): StoredFinding {
  const existing = getStmt.get(f.findingKey) as unknown as Row | undefined;
  if (existing) {
    touchStmt.run(f.now, f.severity, f.who, f.headline, f.detail, f.url ?? null, f.findingKey);
  } else {
    insertStmt.run(
      f.findingKey,
      f.kind,
      f.severity,
      f.who,
      f.project ?? null,
      f.headline,
      f.detail,
      f.url ?? null,
      f.itemId ?? null,
      f.itemSource ?? null,
      f.now,
      f.now,
    );
  }
  return fromRow(getStmt.get(f.findingKey) as unknown as Row);
}

/** מסמן כ-resolved כל ממצא פעיל שלא נראה בסריקה הנוכחית (last_seen ישן מה-cutoff). */
export function resolveStaleFindings(cutoffIso: string, resolvedAtIso: string): void {
  resolveStaleStmt.run(resolvedAtIso, cutoffIso);
}

export function listActiveFindings(): StoredFinding[] {
  return (listActiveStmt.all() as unknown as Row[]).map(fromRow);
}

export function setEscalation(findingKey: string, level: number, atIso: string): void {
  setEscalationStmt.run(level, atIso, findingKey);
}

// ---- לדוח השבועי ----
const openedSinceStmt = db.prepare(`SELECT * FROM control_findings WHERE first_seen >= ?`);
const resolvedSinceStmt = db.prepare(`SELECT * FROM control_findings WHERE resolved_at IS NOT NULL AND resolved_at >= ?`);
const chronicStmt = db.prepare(
  `SELECT * FROM control_findings WHERE resolved_at IS NULL AND first_seen < ? ORDER BY first_seen ASC`,
);

export function findingsOpenedSince(iso: string): StoredFinding[] {
  return (openedSinceStmt.all(iso) as unknown as Row[]).map(fromRow);
}
export function findingsResolvedSince(iso: string): StoredFinding[] {
  return (resolvedSinceStmt.all(iso) as unknown as Row[]).map(fromRow);
}
export function chronicFindings(iso: string): StoredFinding[] {
  return (chronicStmt.all(iso) as unknown as Row[]).map(fromRow);
}
