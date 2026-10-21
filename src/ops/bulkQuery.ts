/**
 * מנוע סינון בשפה טבעית — "הצג את המשימות של איתן שעבר להן התאריך", "לידים פתוחים שלא טופלו השבוע".
 *
 * המודל מתרגם את הבקשה לאובייקט BulkFilters (כלי query_records ב-ops/chat.ts); כאן — בקוד, לא בפרומפט:
 *   1. אימות ופענוח הסינון (תאריכים יחסיים דרך relativeDates.ts) — *לפני* כל קריאה ל-Monday.
 *   2. הרשאות: מי רשאי לראות את העבודה של מי (roles.ts) + scope פר-פרויקט למנהל/ת פרויקט.
 *   3. שליפה מלאה (pagination) — סינון האחראי בצד Monday (fetchUserOpsTasks / fetchLeadsForBulk),
 *      שאר התנאים כאן. שליפה שנכשלה למקור אחד → complete=false, לעולם לא "0 תוצאות" בשקט.
 *
 * סוגי רשומות נתמכים: tasks (בורד "משימות 📝" + תת-משימות "מאגר משימות פרויקטים" — **פתוחות בלבד**,
 * כמו בכל שאר החלונית), leads (בורד הלידים), deals (בורד העסקאות — קריאה בלבד) ו-commitments
 * (התחייבויות פתוחות מה-DB שלנו — קריאה בלבד). recordTypes עם כמה סוגים = "כל מה שיש לי ב..."
 * (2026-10-21). אין כאן כתיבה — ר' bulkUpdate.ts.
 */

import { DateTime } from "luxon";
import { resolveUsersByAssigneeText, TEAM_DIRECTORY, resolveUserByKey, userCan, type IdentifiedUser } from "../identity/index.js";
import { fetchActiveProjects, fetchUserOpsTasks, type OpsTask, type ProjectMeta } from "../integrations/monday/opsRead.js";
import { fetchDealsForBulk, fetchLeadsForBulk, type BulkDeal, type BulkItemKind, type BulkLead } from "../integrations/monday/bulkRead.js";
import { DEAL_CLOSED } from "../integrations/monday/crmRead.js";
import { listUserCommitments, type Commitment } from "../db/repositories/commitments.js";
import { resolveDateExpr, type DateRange } from "./relativeDates.js";

export type BulkRecordType = "tasks" | "leads" | "deals" | "commitments";
export const ALL_RECORD_TYPES: readonly BulkRecordType[] = ["tasks", "leads", "deals", "commitments"];
/** סוג רשומה בודדת — כולל סוגים שהם קריאה בלבד (עסקה/התחייבות; עדכון קבוצתי לא נתמך להם). */
export type BulkRecordKind = BulkItemKind | "deal" | "commitment";

/** הסינון כפי שהמודל ממלא אותו — recordType (סוג יחיד) או recordTypes (כמה סוגים יחד). */
export interface BulkFilters {
  recordType?: BulkRecordType;
  /** כמה סוגים יחד — "כל מה שיש לי מחר" = כל הסוגים; "תביא גם את הלידים" = הקודמים + leads */
  recordTypes?: BulkRecordType[];
  /** שמות אנשים; "אני" = המשתמש; "כולם" = כל הצוות. ריק → משימות: המשתמש עצמו; לידים: לפי ה-scope שלו. */
  assignees?: string[];
  /** שם (או חלק משם) פרויקט — משימות בלבד */
  projects?: string[];
  excludeProjects?: string[];
  /** רק משימות בפרויקטים פעילים (לא הסתיים/נמכר) */
  activeProjectsOnly?: boolean;
  statuses?: string[];
  excludeStatuses?: string[];
  /** משימות בלבד — "קריטי", "גבוה"... */
  priorities?: string[];
  /** תאריך יעד (משימה) / תאריך תזכורת הבא (ליד) — ביטוי יחסי או מפורש: "מחר", "שבוע הבא", "2026-10-25" */
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  /** התאריך עבר (לפני היום) */
  overdue?: boolean;
  /** בלי תאריך בכלל */
  noDate?: boolean;
  /** לידים בלבד — לא עודכנו מאז (ביטוי תאריך; נלקחת תחילת הטווח) */
  notUpdatedSince?: string;
  nameContains?: string;
  /** לידים בלבד — לכלול גם סגורים/שהמשיכו הלאה (לא רלוונטי / נסגר בהצלחה / עבר לעסקה / הוקפא) */
  includeClosed?: boolean;
  /** פנימי — רשומות שהוחרגו במפורש ("חוץ מהשלישית") */
  excludeItemIds?: string[];
}

export interface BulkRecord {
  itemId: string;
  kind: BulkRecordKind;
  name: string;
  project?: string;
  projectId?: string;
  stage?: string;
  status: string;
  priority?: string;
  /** תאריך יעד / תאריך תזכורת */
  date?: string;
  assignees: string;
  updatedAt?: string;
  url: string;
}

export interface CompiledFilters {
  raw: BulkFilters;
  dateRange?: DateRange;
  updatedBefore?: string;
  todayISO: string;
}

export type BulkQueryOutcome =
  | {
      ok: true;
      /** "mixed" = כמה סוגים בתוצאה אחת */
      recordType: BulkRecordType | "mixed";
      /** הסוגים שנכללו בפועל (בתוצאה משולבת — לפי סדר התצוגה) */
      types?: BulkRecordType[];
      records: BulkRecord[];
      /** false = לפחות מקור אחד לא נשלף — התוצאות חלקיות */
      complete: boolean;
      failures: string[];
      filtersText: string;
      notes: string[];
    }
  | { ok: false; error: string };

/**
 * "ליד פתוח" כברירת מחדל = לא סגור וגם לא "המשיך הלאה" — אותם סטטוסים ש-crmScan.ts מדלג עליהם
 * (LEAD_MOVED_ON). נמצא בבדיקה חיה (2026-10-21): 91 מתוך 92 "פתוחים" היו "עבר לעסקה". סטטוס
 * שהתבקש במפורש (statuses) או includeClosed — עוקפים את זה.
 */
const LEAD_NOT_OPEN = new Set(["לא רלוונטי", "נסגר בהצלחה", "עבר לעסקה", "הוקפא"]);
/** "בלי סטטוס" — בנתוני אמת רוב תת-המשימות בלי סטטוס בכלל (תווית ריקה), לא "טרם הוגדר". */
const EMPTY_STATUS_WORDS = /^(|בלי סטטוס|ללא סטטוס|אין סטטוס|ריק|ריקה|empty|none|no status)$/i;

function statusMatches(status: string, query: string): boolean {
  if (EMPTY_STATUS_WORDS.test(query.trim())) return status.trim() === "";
  return looseMatch(status, query);
}
const TASK_CLOSED_WORDS = /^(בוצע|הושלם|done|completed?|סגור|סגורות|מושהה|לא רלוונטי)$/i;

/** נרמול להשוואת טקסט חופשית: בלי אמוג'י/פיסוק, אותיות קטנות, ו"מתתין" (שגיאת כתיב בבורד) = "ממתין". */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/מתתין/g, "ממתין")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looseMatch(value: string | undefined, query: string): boolean {
  if (!value) return false;
  const v = normText(value);
  const q = normText(query);
  return !!q && (v.includes(q) || (v.length >= 2 && q.includes(v)));
}

// ---------------------------------------------------------------------------
// אימות ופענוח (טהור)
// ---------------------------------------------------------------------------

/** הסוגים המבוקשים, מאומתים. recordTypes גובר על recordType. */
export function requestedTypes(filters: BulkFilters): BulkRecordType[] {
  const raw = filters.recordTypes?.length ? filters.recordTypes : filters.recordType ? [filters.recordType] : [];
  if (!raw.length) throw new Error("לא צוין סוג רשומות (recordType / recordTypes).");
  const bad = raw.filter((t) => !ALL_RECORD_TYPES.includes(t));
  if (bad.length) {
    throw new Error(`סוג רשומות לא נתמך: "${bad.join(", ")}". נתמכים: tasks (משימות), leads (לידים), deals (עסקאות), commitments (התחייבויות). אמור זאת למשתמש במפורש.`);
  }
  return [...new Set(raw)];
}

/** פענוח לסוג *יחיד* (raw.recordType). כמה סוגים — runBulkQuery מפצל וקורא לזה לכל סוג. */
export function compileFilters(filters: BulkFilters, now: DateTime): CompiledFilters {
  const types = requestedTypes(filters);
  if (types.length !== 1) throw new Error("compileFilters מקבל סוג יחיד");
  filters = { ...filters, recordType: types[0], recordTypes: undefined };
  const todayISO = now.toFormat("yyyy-MM-dd");
  const out: CompiledFilters = { raw: filters, todayISO };

  const parse = (expr: string, field: string): DateRange => {
    const r = resolveDateExpr(expr, now);
    if (!r) throw new Error(`לא הבנתי את התאריך "${expr}" (${field}) — שאל את המשתמש לתאריך מדויק (למשל 25/10) ואל תנחש.`);
    return r;
  };

  if (filters.date && (filters.dateFrom || filters.dateTo)) {
    throw new Error("date לא משתלב עם dateFrom/dateTo — השתמש באחד מהם.");
  }
  if (filters.date) out.dateRange = parse(filters.date, "date");
  if (filters.dateFrom || filters.dateTo) {
    const from = filters.dateFrom ? parse(filters.dateFrom, "dateFrom").from : "0000-01-01";
    const to = filters.dateTo ? parse(filters.dateTo, "dateTo").to : "9999-12-31";
    if (from > to) throw new Error(`טווח תאריכים הפוך: ${from} אחרי ${to}.`);
    out.dateRange = { from, to };
  }
  if (filters.noDate && (out.dateRange || filters.overdue)) {
    throw new Error("noDate (בלי תאריך) סותר סינון לפי תאריך/איחור — שאל את המשתמש למה התכוון.");
  }
  if (filters.notUpdatedSince) {
    if (filters.recordType !== "leads" && filters.recordType !== "deals") throw new Error("notUpdatedSince נתמך כרגע ללידים ולעסקאות בלבד.");
    out.updatedBefore = parse(filters.notUpdatedSince, "notUpdatedSince").from;
  }
  if (filters.recordType !== "tasks") {
    if (filters.projects?.length || filters.excludeProjects?.length || filters.activeProjectsOnly) {
      throw new Error("סינון לפי פרויקט רלוונטי רק למשימות — שאל את המשתמש אם להציג רק משימות.");
    }
    if (filters.priorities?.length) throw new Error("סינון תעדוף רלוונטי רק למשימות — שאל את המשתמש אם להציג רק משימות.");
  }
  if (filters.recordType === "tasks") {
    if (filters.includeClosed) throw new Error("ניתן לסנן רק משימות פתוחות — משימות שבוצעו לא נשלפות.");
    const closed = (filters.statuses ?? []).filter((s) => TASK_CLOSED_WORDS.test(s.trim()));
    if (closed.length) {
      throw new Error(`ניתן לסנן רק משימות פתוחות — "${closed.join(", ")}" לא נתמך. אמור זאת למשתמש.`);
    }
  }
  return out;
}

/** מסנן רשומות שכבר נשלפו לפי כל התנאים שאינם "אחראי" (שכבר סונן בשליפה). טהור. */
export function applyFilters(records: BulkRecord[], c: CompiledFilters, activeProjectIds?: Set<string>): BulkRecord[] {
  const f = c.raw;
  const excluded = new Set(f.excludeItemIds ?? []);
  const out = records.filter((r) => {
    if (excluded.has(r.itemId)) return false;
    const notOpen = r.kind === "lead" ? LEAD_NOT_OPEN.has(r.status) : r.kind === "deal" ? DEAL_CLOSED.has(r.status) : false;
    if (notOpen && !f.includeClosed && !(f.statuses ?? []).some((s) => statusMatches(r.status, s))) return false;
    if (f.projects?.length && !f.projects.some((p) => looseMatch(r.project, p))) return false;
    if (f.excludeProjects?.length && f.excludeProjects.some((p) => looseMatch(r.project, p))) return false;
    if (f.activeProjectsOnly && !(r.projectId && activeProjectIds?.has(r.projectId))) return false;
    if (f.statuses?.length && !f.statuses.some((s) => statusMatches(r.status, s))) return false;
    if (f.excludeStatuses?.length && f.excludeStatuses.some((s) => statusMatches(r.status, s))) return false;
    if (f.priorities?.length && !f.priorities.some((p) => looseMatch(r.priority, p))) return false;
    if (c.dateRange && !(r.date && r.date >= c.dateRange.from && r.date <= c.dateRange.to)) return false;
    if (f.overdue && !(r.date && r.date < c.todayISO)) return false;
    if (f.noDate && r.date) return false;
    if (c.updatedBefore && !(r.updatedAt && r.updatedAt.slice(0, 10) < c.updatedBefore)) return false;
    if (f.nameContains && !looseMatch(r.name, f.nameContains)) return false;
    return true;
  });
  out.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.name.localeCompare(b.name, "he"));
  return out;
}

/** מיזוג סינון המשך ("חוץ מפרויקט X") לתוך הסינון הקודם: שדות חדשים דורסים, רשימות exclude* מצטברות. */
export function mergeFilters(prev: BulkFilters, next: Partial<BulkFilters>): BulkFilters {
  const merged: BulkFilters = { ...prev };
  for (const [k, v] of Object.entries(next) as [keyof BulkFilters, unknown][]) {
    if (v === undefined || v === null) continue;
    if (k === "excludeProjects" || k === "excludeStatuses" || k === "excludeItemIds") {
      merged[k] = [...new Set([...(prev[k] ?? []), ...(v as string[])])];
    } else {
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
  }
  // סוג/סוגים חדשים מחליפים את הקודמים (לא מצטברים) — "גם הלידים" = המודל מעביר את הרשימה המלאה
  if (next.recordTypes?.length) delete merged.recordType;
  else if (next.recordType) delete merged.recordTypes;
  // טווח חדש מבטל date קודם ולהפך — אחרת compileFilters ידחה שילוב של שניהם
  if (next.date) {
    delete merged.dateFrom;
    delete merged.dateTo;
  } else if (next.dateFrom || next.dateTo) {
    delete merged.date;
  }
  return merged;
}

const pretty = (iso: string) => DateTime.fromISO(iso).toFormat("dd/MM");

export function describeFilters(c: CompiledFilters, peopleText: string): string {
  const f = c.raw;
  const NOUN: Record<BulkRecordType, string> = {
    tasks: "משימות פתוחות",
    leads: f.includeClosed ? "לידים (כולל סגורים)" : "לידים פתוחים",
    deals: f.includeClosed ? "עסקאות (כולל סגורות)" : "עסקאות פתוחות",
    commitments: "התחייבויות פתוחות",
  };
  const parts: string[] = [requestedTypes(f).map((t) => NOUN[t]).join(" + ")];
  if (peopleText) parts.push(`של: ${peopleText}`);
  if (f.projects?.length) parts.push(`פרויקט: ${f.projects.join(" / ")}`);
  if (f.excludeProjects?.length) parts.push(`חוץ מפרויקט: ${f.excludeProjects.join(", ")}`);
  if (f.activeProjectsOnly) parts.push("בפרויקטים פעילים");
  if (f.statuses?.length) parts.push(`סטטוס: ${f.statuses.join(" / ")}`);
  if (f.excludeStatuses?.length) parts.push(`חוץ מסטטוס: ${f.excludeStatuses.join(", ")}`);
  if (f.priorities?.length) parts.push(`תעדוף: ${f.priorities.join(" / ")}`);
  const types = requestedTypes(f);
  const dateWord = types.length > 1 ? "תאריך" : types[0] === "leads" || types[0] === "deals" ? "תזכורת" : "תאריך יעד";
  if (c.dateRange) {
    const { from, to } = c.dateRange;
    if (from === to) parts.push(`${dateWord}: ${pretty(from)}`);
    else if (from === "0000-01-01") parts.push(`${dateWord} עד ${pretty(to)}`);
    else if (to === "9999-12-31") parts.push(`${dateWord} מ-${pretty(from)}`);
    else parts.push(`${dateWord}: ${pretty(from)}–${pretty(to)}`);
  }
  if (f.overdue) parts.push(types.length === 1 && (types[0] === "leads" || types[0] === "deals") ? "תזכורת שעברה" : "באיחור");
  if (f.noDate) parts.push(`בלי ${dateWord}`);
  if (c.updatedBefore) parts.push(`לא עודכנו מאז ${pretty(c.updatedBefore)}`);
  if (f.nameContains) parts.push(`שם מכיל: "${f.nameContains}"`);
  if (f.excludeItemIds?.length) parts.push(`${f.excludeItemIds.length} הוחרגו ידנית`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// אנשים + הרשאות
// ---------------------------------------------------------------------------

const SELF_WORDS = /^(אני|אנוכי|שלי|me|mine|myself|self)$/i;
const ALL_WORDS = /^(כולם|כל הצוות|הצוות|כל המשרד|all|everyone|team)$/i;

export function resolvePeople(user: IdentifiedUser, names: string[]): IdentifiedUser[] {
  const out: IdentifiedUser[] = [];
  const add = (u: IdentifiedUser) => {
    if (!out.some((x) => x.key === u.key)) out.push(u);
  };
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (SELF_WORDS.test(name)) {
      add(user);
      continue;
    }
    if (ALL_WORDS.test(name)) {
      for (const m of TEAM_DIRECTORY) if (m.mondayUserId) add(resolveUserByKey(m.key)!);
      continue;
    }
    const hits = resolveUsersByAssigneeText(name);
    if (hits.length === 0) throw new Error(`לא מצאתי בצוות אדם בשם "${name}" — שאל את המשתמש למי הכוונה.`);
    if (hits.length > 1) throw new Error(`"${name}" מתאים לכמה אנשים: ${hits.map((h) => h.name).join(", ")} — שאל למי הכוונה.`);
    add(hits[0]!);
  }
  return out;
}

function isOwnerOrAdmin(user: IdentifiedUser): boolean {
  return user.role === "owner" || user.role === "admin";
}

// ---------------------------------------------------------------------------
// שליפה
// ---------------------------------------------------------------------------

export interface BulkQueryDeps {
  fetchUserOpsTasks?: (mondayUserId: string) => Promise<OpsTask[]>;
  fetchLeadsForBulk?: (ownerMondayId?: string) => Promise<BulkLead[]>;
  fetchDealsForBulk?: (ownerMondayId?: string) => Promise<BulkDeal[]>;
  listUserCommitments?: (userKey: string) => Commitment[];
  fetchActiveProjects?: () => Promise<ProjectMeta[]>;
}

function taskToRecord(t: OpsTask): BulkRecord {
  return {
    itemId: t.itemId,
    kind: t.source,
    name: t.name,
    project: t.source === "general" && t.context === "משימת משרד" ? undefined : t.context,
    projectId: t.projectId,
    stage: t.stageName,
    status: t.status,
    priority: t.priority,
    date: t.dueDate,
    assignees: t.assignees,
    url: t.url,
  };
}

function dealToRecord(d: BulkDeal): BulkRecord {
  return {
    itemId: d.itemId,
    kind: "deal",
    name: d.name,
    status: d.stage,
    date: d.reminderDate,
    assignees: d.owner,
    updatedAt: d.updatedAt,
    url: d.url,
  };
}

function commitmentToRecord(c: Commitment): BulkRecord {
  return {
    itemId: `c${c.id}`,
    kind: "commitment",
    name: `${c.what} (ל${c.toWhom})`,
    project: c.project ?? undefined,
    status: "פתוחה",
    date: c.dueDate ?? undefined,
    assignees: "",
    url: "",
  };
}

function leadToRecord(l: BulkLead): BulkRecord {
  return {
    itemId: l.itemId,
    kind: "lead",
    name: l.name,
    status: l.status,
    date: l.reminderDate,
    assignees: l.owner,
    updatedAt: l.updatedAt,
    url: l.url,
  };
}

/** מריץ עד `limit` הבטחות במקביל (Monday מגביל complexity לדקה — לא לשלוח את כל הצוות בבת אחת). */
async function settledPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function runBulkQuery(
  user: IdentifiedUser,
  filters: BulkFilters,
  now: DateTime,
  deps: BulkQueryDeps = {},
): Promise<BulkQueryOutcome> {
  let types: BulkRecordType[];
  try {
    types = requestedTypes(filters);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (types.length === 1) return querySingle(user, { ...filters, recordType: types[0], recordTypes: undefined }, now, deps, false);

  // כמה סוגים ("כל מה שיש לי מחר"): אותו סינון לכל סוג, ובלי assignees = של המשתמש עצמו בכל הסוגים
  // (גם לבעלים — "שלי", לא כל הלידים במשרד). סוג שאין עליו הרשאה מדולג עם הערה מפורשת, לא נכשל.
  const base: BulkFilters = { ...filters, recordTypes: undefined, assignees: filters.assignees?.length ? filters.assignees : ["אני"] };
  const records: BulkRecord[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  const included: BulkRecordType[] = [];
  for (const t of types) {
    const o = await querySingle(user, { ...base, recordType: t }, now, deps, true);
    if (!o.ok) {
      if (o.error.startsWith(PERMISSION_SKIP)) notes.push(o.error.slice(PERMISSION_SKIP.length));
      else return o; // סינון לא חוקי / כשל מלא בשליפה — לא מציגים תמונה חלקית כאילו היא מלאה
      continue;
    }
    included.push(t);
    records.push(...o.records);
    failures.push(...o.failures);
    notes.push(...o.notes);
  }
  if (!included.length) return { ok: false, error: notes.join(" ") || "אין סוג רשומות שמותר לך לצפות בו." };
  let compiled: CompiledFilters;
  let people: IdentifiedUser[];
  try {
    compiled = compileFilters({ ...base, recordType: included[0] }, now);
    people = resolvePeople(user, base.assignees ?? []);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  // מקובץ לפי סוג (בסדר התצוגה), ובתוך סוג — לפי תאריך. הסדר השמור = המספור המוצג (excludeIndexes)
  const order = (r: BulkRecord) => included.indexOf(KIND_TYPE[r.kind]);
  records.sort((a, b) => order(a) - order(b) || (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.name.localeCompare(b.name, "he"));
  return {
    ok: true,
    recordType: included.length > 1 ? "mixed" : included[0]!,
    types: included,
    records,
    complete: failures.length === 0,
    failures,
    filtersText: describeFilters({ ...compiled, raw: { ...compiled.raw, recordType: undefined, recordTypes: included } }, people.map((p) => (p.key === user.key ? "אני" : p.name)).join(", ")),
    notes,
  };
}

const KIND_TYPE: Record<BulkRecordKind, BulkRecordType> = {
  general: "tasks",
  project_stage: "tasks",
  lead: "leads",
  deal: "deals",
  commitment: "commitments",
};

/** קידומת פנימית: "אין הרשאה לסוג הזה" — בשאילתה משולבת מדלגים עליו עם הערה במקום להיכשל. */
const PERMISSION_SKIP = "\u0000skip:";

async function querySingle(
  user: IdentifiedUser,
  filters: BulkFilters,
  now: DateTime,
  deps: BulkQueryDeps,
  inMixed: boolean,
): Promise<BulkQueryOutcome> {
  let compiled: CompiledFilters;
  let people: IdentifiedUser[];
  try {
    compiled = compileFilters(filters, now);
    people = resolvePeople(user, filters.assignees ?? []);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const skip = (msg: string): BulkQueryOutcome => ({ ok: false, error: inMixed ? PERMISSION_SKIP + msg : msg });
  switch (filters.recordType) {
    case "tasks":
      return queryTasks(user, compiled, people, deps);
    case "leads":
      return queryCrm(user, compiled, people, deps, "leads", skip);
    case "deals":
      return queryCrm(user, compiled, people, deps, "deals", skip);
    default:
      return queryCommitments(user, compiled, people, deps, skip);
  }
}

async function queryTasks(
  user: IdentifiedUser,
  compiled: CompiledFilters,
  requested: IdentifiedUser[],
  deps: BulkQueryDeps,
): Promise<BulkQueryOutcome> {
  if (!userCan(user, "view:own_work")) return { ok: false, error: "אין לך הרשאה לצפות במשימות." };
  if (!user.mondayUserId && requested.length === 0) return { ok: false, error: "אין לך חשבון Monday מקושר." };
  const people = requested.length ? requested : [user];
  const notes: string[] = [];

  const others = people.filter((p) => p.key !== user.key);
  const fullView = userCan(user, "view:all_work");
  const scopedView = !fullView && userCan(user, "view:managed_projects");
  if (others.length && !fullView && !scopedView) {
    return { ok: false, error: `אין לך הרשאה לצפות במשימות של ${others.map((o) => o.name).join(", ")} — רק במשימות שלך.` };
  }
  const withoutMonday = people.filter((p) => !p.mondayUserId);
  for (const p of withoutMonday) notes.push(`ל${p.name} אין חשבון Monday — אין לו/ה משימות במערכת.`);
  const targets = people.filter((p) => p.mondayUserId);

  const doFetch = deps.fetchUserOpsTasks ?? fetchUserOpsTasks;
  const settled = await settledPool(targets, 2, (p) => doFetch(p.mondayUserId!));
  const failures: string[] = [];
  const byId = new Map<string, BulkRecord>();
  /** משימות שחזרו מהשליפה של המשתמש עצמו (סינון person בצד Monday) — "שלי" לפי מזהה, לא לפי שם */
  const ownItemIds = new Set<string>();
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      failures.push(`המשימות של ${targets[i]!.name}`);
      return;
    }
    const isSelf = targets[i]!.key === user.key;
    for (const t of s.value) {
      if (isSelf) ownItemIds.add(t.itemId);
      if (!byId.has(t.itemId)) byId.set(t.itemId, taskToRecord(t));
    }
  });
  if (targets.length && failures.length === targets.length) {
    return { ok: false, error: `השליפה מ-Monday נכשלה (${failures.join(", ")}). לא ניתן להציג תוצאות — נסה שוב בעוד רגע.` };
  }

  let records = [...byId.values()];

  // scope של מנהל/ת פרויקט: משימות של אחרים — רק בפרויקטים שהוא/היא מנהל/ת
  let activeProjectIds: Set<string> | undefined;
  const needProjects = compiled.raw.activeProjectsOnly || (scopedView && others.length > 0);
  if (needProjects) {
    let projects: ProjectMeta[];
    try {
      projects = await (deps.fetchActiveProjects ?? fetchActiveProjects)();
    } catch {
      return { ok: false, error: "לא הצלחתי לשלוף את רשימת הפרויקטים מ-Monday — נסה שוב בעוד רגע." };
    }
    activeProjectIds = new Set(projects.map((p) => p.itemId));
    if (scopedView && others.length) {
      const managed = new Set(projects.filter((p) => p.ownerIds.includes(user.mondayUserId ?? "")).map((p) => p.itemId));
      const before = records.length;
      records = records.filter((r) => ownItemIds.has(r.itemId) || (!!r.projectId && managed.has(r.projectId)));
      if (records.length < before) {
        notes.push(`מוצגות רק משימות בפרויקטים שאת/ה מנהל/ת (${before - records.length} משימות של אחרים מחוץ לפרויקטים שלך לא מוצגות).`);
      }
    }
  }

  const filtered = applyFilters(records, compiled, activeProjectIds);
  return {
    ok: true,
    recordType: "tasks",
    records: filtered,
    complete: failures.length === 0,
    failures,
    filtersText: describeFilters(compiled, people.map((p) => (p.key === user.key ? "אני" : p.name)).join(", ")),
    notes,
  };
}

async function queryCrm(
  user: IdentifiedUser,
  compiled: CompiledFilters,
  requested: IdentifiedUser[],
  deps: BulkQueryDeps,
  type: "leads" | "deals",
  skip: (msg: string) => BulkQueryOutcome,
): Promise<BulkQueryOutcome> {
  const noun = type === "leads" ? "לידים" : "עסקאות";
  if (!userCan(user, "lead:manage") && !userCan(user, "view:all_work")) {
    return skip(`${noun} — אין לך הרשאה לצפות בהם, לא נכללו.`);
  }
  const seeAll = isOwnerOrAdmin(user);
  // בלי owner/admin — רק הלידים של המשתמש עצמו (אותו scope כמו findLeadAction ב-actions.ts)
  if (!seeAll) {
    const others = requested.filter((p) => p.key !== user.key);
    if (others.length) return { ok: false, error: `אין לך הרשאה לצפות ב${noun} של ${others.map((o) => o.name).join(", ")} — רק בשלך.` };
    if (!user.mondayUserId) return { ok: false, error: "אין לך חשבון Monday מקושר." };
  }
  const owners = seeAll ? requested : [user];
  const ownerIds = owners.map((o) => o.mondayUserId).filter((x): x is string => !!x);
  if (owners.length && !ownerIds.length) return skip(`ל${owners.map((o) => o.name).join(", ")} אין חשבון Monday — אין ${noun} באחריותו/ה.`);

  let rows: (BulkLead | BulkDeal)[];
  try {
    const doFetch = type === "leads" ? (deps.fetchLeadsForBulk ?? fetchLeadsForBulk) : (deps.fetchDealsForBulk ?? fetchDealsForBulk);
    // אחראי יחיד → סינון בצד Monday; כמה → שליפה אחת של הכל וסינון כאן (במקום N שליפות)
    rows = await doFetch(ownerIds.length === 1 ? ownerIds[0] : undefined);
  } catch {
    return { ok: false, error: `השליפה מבורד ה${noun} ב-Monday נכשלה. לא ניתן להציג תוצאות — נסה שוב בעוד רגע.` };
  }
  if (ownerIds.length > 1) rows = rows.filter((l) => l.ownerIds.some((id) => ownerIds.includes(id)));
  if (!seeAll) rows = rows.filter((l) => l.ownerIds.includes(user.mondayUserId!));

  const filtered = applyFilters(
    type === "leads" ? (rows as BulkLead[]).map(leadToRecord) : (rows as BulkDeal[]).map(dealToRecord),
    compiled,
  );
  return {
    ok: true,
    recordType: type,
    records: filtered,
    complete: true,
    failures: [],
    filtersText: describeFilters(compiled, owners.map((p) => (p.key === user.key ? "אני" : p.name)).join(", ")),
    notes: [],
  };
}

/** התחייבויות פתוחות (DB שלנו, לא Monday) — אישיות במהותן: רק של המשתמש עצמו. */
async function queryCommitments(
  user: IdentifiedUser,
  compiled: CompiledFilters,
  requested: IdentifiedUser[],
  deps: BulkQueryDeps,
  skip: (msg: string) => BulkQueryOutcome,
): Promise<BulkQueryOutcome> {
  const others = requested.filter((p) => p.key !== user.key);
  if (others.length) return skip("התחייבויות מוצגות רק למי שרשם אותן — לא נכללו התחייבויות של אחרים.");
  const list = (deps.listUserCommitments ?? listUserCommitments)(user.key).filter((c) => c.status === "open");
  return {
    ok: true,
    recordType: "commitments",
    records: applyFilters(list.map(commitmentToRecord), compiled),
    complete: true,
    failures: [],
    filtersText: describeFilters(compiled, "אני"),
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// תצוגה
// ---------------------------------------------------------------------------

export const QUERY_DISPLAY_CAP = 40;

export function formatRecordLine(r: BulkRecord, index: number): string {
  const bits: string[] = [];
  if (r.project) bits.push(r.stage ? `${r.project} · ${r.stage}` : r.project);
  const crm = r.kind === "lead" || r.kind === "deal";
  if (r.date) bits.push(`${crm ? "תזכורת" : "יעד"} ${pretty(r.date)}`);
  else bits.push(crm ? "בלי תזכורת" : "בלי תאריך");
  bits.push(r.status || "בלי סטטוס");
  if (r.priority) bits.push(r.priority);
  if (r.assignees) bits.push(r.assignees);
  return `${index}. ${r.name} — ${bits.join(" · ")}`;
}

/** הטקסט שמוצג למשתמש מילה במילה (chat.ts) — מספרים אמיתיים בלבד, אין "ועוד" בלי מספר. */
const TYPE_NOUN: Record<BulkRecordType | "mixed", string> = { tasks: "משימות", leads: "לידים", deals: "עסקאות", commitments: "התחייבויות", mixed: "רשומות" };

export function formatQueryText(o: Extract<BulkQueryOutcome, { ok: true }>): string {
  const noun = TYPE_NOUN[o.recordType];
  const lines: string[] = [];
  if (o.recordType === "mixed") {
    // מקובץ לפי סוג, עם ספירה לכל סוג (גם 0) — המספור רציף כדי ש"חוץ מהשלישית" יעבוד על כל הרשימה
    lines.push(o.records.length ? `נמצאו ${o.records.length} רשומות (${o.filtersText}):` : `לא נמצאו רשומות שתואמות לסינון: ${o.filtersText}.`);
    let i = 0;
    let shown = 0;
    for (const t of o.types ?? []) {
      const rows = o.records.filter((r) => KIND_TYPE[r.kind] === t);
      lines.push("", `${TYPE_NOUN[t]} (${rows.length}):`);
      if (!rows.length) lines.push("אין");
      for (const r of rows) {
        i++;
        if (shown < QUERY_DISPLAY_CAP) {
          lines.push(formatRecordLine(r, i));
          shown++;
        }
      }
    }
    if (o.records.length > QUERY_DISPLAY_CAP) {
      lines.push(`…ועוד ${o.records.length - QUERY_DISPLAY_CAP} (מוצגות ${QUERY_DISPLAY_CAP} הראשונות מתוך ${o.records.length}).`);
    }
    lines.push("", "ℹ️ פגישות ביומן (Google Calendar) לא נכללות בתצוגה הזו.");
  } else if (o.records.length === 0) {
    lines.push(`לא נמצאו ${noun} שתואמות לסינון: ${o.filtersText}.`);
  } else {
    lines.push(`נמצאו ${o.records.length} ${noun} (${o.filtersText}):`);
    o.records.slice(0, QUERY_DISPLAY_CAP).forEach((r, i) => lines.push(formatRecordLine(r, i + 1)));
    if (o.records.length > QUERY_DISPLAY_CAP) {
      lines.push(`…ועוד ${o.records.length - QUERY_DISPLAY_CAP} (מוצגות ${QUERY_DISPLAY_CAP} הראשונות מתוך ${o.records.length}).`);
    }
  }
  if (!o.complete) {
    lines.push(
      "",
      `⚠️ השליפה חלקית — לא הצלחתי לשלוף את ${o.failures.join(", ")}. התוצאות אינן מלאות, ועדכון קבוצתי לא יתאפשר עד שליפה מלאה.`,
    );
  }
  for (const n of o.notes) lines.push(`ℹ️ ${n}`);
  return lines.join("\n");
}
