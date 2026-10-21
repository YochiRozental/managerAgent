/**
 * עדכון קבוצתי בשפה טבעית — "העבר את כל המשימות של מחר ליום ראשון", "שנה את כל המשימות של דוב
 * בפרויקט X לסטטוס ממתין". שלושה שלבים, כל אחד מוכרע בקוד ולא בפרומפט:
 *
 *   1. prepareBulkUpdate — לוקח קבוצת תוצאות *מלאה* (bulk_result_sets, מ-query_records), קורא כל
 *      רשומה מחדש מ-Monday (snapshot טרי), בודק הרשאה פר-רשומה, מחשב את הערך החדש, ושומר תוכנית
 *      (bulk_plans) שממתינה לאישור. מחזיר תצוגה מקדימה: כמה, סינון, שינוי, הרשימה המלאה, מי לא יעודכן.
 *   2. confirmBulkUpdate — רק אם: התוכנית שייכת למשתמש+לשיחה, נוצרה בהודעה *קודמת* (לא באותו סבב),
 *      וההודעה האחרונה של המשתמש היא אישור מפורש (isExplicitConfirmation — דטרמיניסטי, לא שיקול
 *      המודל). CAS awaiting_confirmation→executing מונע ביצוע כפול (אישור חוזר / retry / רשת).
 *   3. לפני כתיבה — קריאה טרייה נוספת והשוואה ל-snapshot. שינוי מהותי (סטטוס/תאריך/תעדוף/אחראי/שם,
 *      או רשומה שנעלמה) → התוכנית מסומנת stale ולא נכתב כלום; צריך תצוגה ואישור מחדש.
 *      ביצוע רשומה-רשומה (change_multiple_column_values — קריאה אחת לרשומה), כל תוצאה נשמרת מיד.
 *
 * אין כאן מחיקה/ארכוב. "מושהה"/"לא רלוונטי" (ביטול) — רק לבעלים (approve:sensitive), כמו
 * evaluateCancellationRequest ב-policy.ts. שינוי תאריך/תעדוף/אחראי במשימות דורש task:manage
 * (roles.ts: "לקבוע תאריכים, להקצות") — עובד/ת בלי ניהול משימות לא דוחה דדליינים בבת אחת ועוקף
 * את מדיניות הדחיות (deferralPlan.ts). כללי הבעלות/scope זהים ל-authorize/assertManagesItemProject
 * ב-actions.ts, אבל מחושבים מה-snapshot הטרי (בלי קריאת API נוספת לכל רשומה).
 */

import { DateTime } from "luxon";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import { getProjectOwnerIds, type OpsTaskSource } from "../integrations/monday/opsRead.js";
import { addTaskNote, DONE_LABEL, getColumnLabels, PARKED_LABEL, taskStatusLabels } from "../integrations/monday/opsWrite.js";
import { setItemColumnValues } from "../integrations/monday/itemWrite.js";
import { BULK_COLUMNS, readItemsForVerification, type BulkItemKind, type ItemSnapshot } from "../integrations/monday/bulkRead.js";
import {
  casPlanStatus,
  cancelPendingPlans,
  finalizePlan,
  getLatestPendingPlan,
  getLatestResultSet,
  getPlan,
  getResultSet,
  savePlan,
  savePlanProgress,
  type StoredBulkPlan,
} from "../db/repositories/bulkOps.js";
import { logger } from "../utils/logger.js";
import { normText, resolvePeople } from "./bulkQuery.js";
import { resolveSingleDay, shiftIsoDate } from "./relativeDates.js";

/** מעל זה — לא מכינים תוכנית; מבקשים לצמצם את הסינון. */
export const BULK_MAX_ITEMS = 100;
/** תוכנית שלא אושרה תוך כך — פגה. */
export const BULK_PLAN_TTL_MINUTES = 30;

export interface BulkChangeInput {
  /** תאריך יעד חדש (משימה) / תזכורת חדשה (ליד) — ביטוי יום יחיד: "יום ראשון הבא", "25/10" */
  dueDate?: string;
  /** הזזה יחסית של התאריך הקיים בכל רשומה, בימים (שלילי = אחורה) */
  shiftDays?: number;
  status?: string;
  /** משימות בלבד */
  priority?: string;
  assignee?: string;
}

interface PlannedValues {
  status?: string;
  date?: string;
  priority?: string;
  assigneeIds?: string[];
}

export interface PlanItem {
  itemId: string;
  kind: BulkItemKind;
  boardId: string;
  name: string;
  before: ItemSnapshot;
  after: PlannedValues;
  columnValues: Record<string, unknown>;
}

export interface ExcludedItem {
  itemId: string;
  name: string;
  reason: string;
}

interface StoredPlanItems {
  items: PlanItem[];
  excluded: ExcludedItem[];
  filtersText: string;
  assigneeName?: string;
}

export interface BulkReport {
  updated: { itemId: string; name: string }[];
  failed: { itemId: string; name: string; error: string }[];
  notAttempted: { itemId: string; name: string; reason: string }[];
  excluded: ExcludedItem[];
}

export interface BulkContext {
  sessionId: string;
  /** מזהה ההודעה הנוכחית (clientMessageId, או fallback) — אישור חייב להגיע בהודעה אחרת מזו שהכינה את התוכנית */
  turnId: string;
  now: DateTime;
}

export interface BulkUpdateDeps {
  readItemsForVerification?: typeof readItemsForVerification;
  setItemColumnValues?: typeof setItemColumnValues;
  addTaskNote?: typeof addTaskNote;
  getProjectOwnerIds?: typeof getProjectOwnerIds;
  getColumnLabels?: typeof getColumnLabels;
}

export type BulkStepResult = { ok: true; text: string; planId?: string; executed?: boolean } | { ok: false; error: string };

const pretty = (iso: string) => DateTime.fromISO(iso).toFormat("dd/MM");
const isTaskKind = (k: BulkItemKind): k is OpsTaskSource => k === "general" || k === "project_stage";
const KIND_NOUN: Record<BulkItemKind, string> = { general: "משימת משרד", project_stage: "משימת פרויקט", lead: "ליד" };

// ---------------------------------------------------------------------------
// אישור מפורש — דטרמיניסטי
// ---------------------------------------------------------------------------

const AFFIRM = /^(כן|כנ|בטח|מאשר|מאשרת|מאשרים|אישור|מאושר|אשר|אשרי|בצע|בצעי|תבצע|תבצעי|סגור|יאללה|קדימה|אוקיי|אוקי|אוקיי|ok|okay|yes|בסדר|לך על זה|לכי על זה|תעשה את זה|תעשי את זה|תעדכן|תעדכני|עדכן|עדכני|נכון|בדיוק|מעולה|סבבה|👍|✅)(?=$|[\s,.!])/i;
const HEDGE = /(חוץ|בלי|אבל|רק |לא |לא$|אל |רגע|חכה|חכי|תשנה|תשני|במקום|עוד לא|ביטול|בטל|תבטל|\?)/;

/** "כן" / "מאשר" / "כן, תבצע" → true. "כן אבל בלי X" / "לא" / "רגע" / שאלה → false. */
export function isExplicitConfirmation(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60) return false;
  if (HEDGE.test(t)) return false;
  return AFFIRM.test(t);
}

// ---------------------------------------------------------------------------
// התאמת תוויות
// ---------------------------------------------------------------------------

/** תווית מדויקת, או התאמה חלקית *יחידה*. אחרת זורק עם האפשרויות — המודל שואל את המשתמש. */
export function matchLabel(labels: readonly string[], wanted: string, fieldName: string, scopeName: string): string {
  if (labels.includes(wanted)) return wanted;
  const q = normText(wanted);
  const hits = labels.filter((l) => {
    const n = normText(l);
    return !!q && (n === q || n.includes(q));
  });
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new Error(`"${wanted}" מתאים לכמה ${fieldName}ים ב${scopeName}: ${hits.join(" / ")} — שאל את המשתמש איזה.`);
  }
  throw new Error(`"${wanted}" אינו ${fieldName} קיים ב${scopeName}. האפשרויות: ${labels.join(", ")} — שאל את המשתמש.`);
}

const DONE_WORDS = /^(בוצע|הושלם|done|completed?|סיים|סיימתי|גמור)$/i;

async function resolveStatusFor(kind: BulkItemKind, wanted: string, getLabels: typeof getColumnLabels): Promise<string> {
  if (isTaskKind(kind)) {
    if (DONE_WORDS.test(wanted.trim())) return DONE_LABEL[kind];
    return matchLabel(taskStatusLabels(kind), wanted, "סטטוס", KIND_NOUN[kind]);
  }
  const labels = await getLabels(BULK_COLUMNS.lead.boardId, BULK_COLUMNS.lead.status);
  if (!labels.length) throw new Error("לא הצלחתי לקרוא את רשימת הסטטוסים של בורד הלידים — לא מעדכן בלי לאמת.");
  return matchLabel(labels, wanted, "סטטוס", "לידים");
}

async function resolvePriorityFor(kind: OpsTaskSource, wanted: string, getLabels: typeof getColumnLabels): Promise<string> {
  const cols = BULK_COLUMNS[kind];
  const labels = await getLabels(cols.boardId, cols.priority!);
  if (!labels.length) throw new Error("לא הצלחתי לקרוא את רשימת התעדופים מ-Monday — לא מעדכן בלי לאמת.");
  return matchLabel(labels, wanted, "תעדוף", KIND_NOUN[kind]);
}

// ---------------------------------------------------------------------------
// הרשאה פר-רשומה (מה-snapshot הטרי)
// ---------------------------------------------------------------------------

export type WriteAuth = { ok: true } | { ok: false; reason: string };

export function authorizeBulkItem(
  user: IdentifiedUser,
  snap: ItemSnapshot,
  after: PlannedValues,
  projectOwners: Map<string, string[]>,
): WriteAuth {
  const own = !!user.mondayUserId && snap.assigneeIds.includes(user.mondayUserId);
  const ownerOrAdmin = user.role === "owner" || user.role === "admin";

  if (snap.kind === "lead") {
    if (!userCan(user, "lead:manage")) return { ok: false, reason: "אין הרשאה לעדכן לידים" };
    if (!ownerOrAdmin && !own) return { ok: false, reason: "הליד לא באחריותך" };
    return { ok: true };
  }

  if (!userCan(user, "task:update_own")) return { ok: false, reason: "אין הרשאה לעדכן משימות" };
  const managing = after.date !== undefined || after.priority !== undefined || after.assigneeIds !== undefined;
  if (managing && !userCan(user, "task:manage")) {
    return { ok: false, reason: "שינוי תאריך/תעדוף/אחראי דורש הרשאת ניהול משימות — אפשר לבקש ממנהל/ת הפרויקט" };
  }
  if (after.status && after.status === PARKED_LABEL[snap.kind] && !userCan(user, "approve:sensitive")) {
    return { ok: false, reason: `"${after.status}" הוא ביטול/השהיה — דורש אישור מוטי, לא בעדכון קבוצתי` };
  }
  if (own) return { ok: true };
  if (!userCan(user, "task:manage")) return { ok: false, reason: "המשימה לא משויכת אליך" };
  if (ownerOrAdmin) return { ok: true };
  if (!snap.projectId) {
    return snap.kind === "project_stage"
      ? { ok: false, reason: "לא זוהה הפרויקט של המשימה — נחסם לבטיחות" }
      : { ok: true }; // משימת משרד לא מקושרת לפרויקט — אין scope לאכוף (כמו assertManagesItemProject)
  }
  const owners = projectOwners.get(snap.projectId) ?? [];
  if (!user.mondayUserId || !owners.includes(user.mondayUserId)) {
    return { ok: false, reason: "המשימה בפרויקט שאינך מנהל/ת" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// השוואת snapshot
// ---------------------------------------------------------------------------

/** השדות שהשתנו בין התצוגה לעכשיו. ריק = לא השתנה מהותית. */
export function snapshotDiff(before: ItemSnapshot, current: ItemSnapshot | undefined): string[] {
  if (!current) return ["הרשומה לא נמצאה יותר ב-Monday"];
  const diffs: string[] = [];
  if (before.name !== current.name) diffs.push("שם");
  if (before.status !== current.status) diffs.push(`סטטוס (${before.status || "ריק"} → ${current.status || "ריק"})`);
  if ((before.date ?? "") !== (current.date ?? "")) diffs.push(`תאריך (${before.date ? pretty(before.date) : "ריק"} → ${current.date ? pretty(current.date) : "ריק"})`);
  if ((before.priority ?? "") !== (current.priority ?? "")) diffs.push("תעדוף");
  if ([...before.assigneeIds].sort().join(",") !== [...current.assigneeIds].sort().join(",")) diffs.push("אחראי/ת");
  return diffs;
}

// ---------------------------------------------------------------------------
// 1. הכנה + תצוגה מקדימה
// ---------------------------------------------------------------------------

function describeChange(change: BulkChangeInput, resolved: { date?: string; assigneeName?: string }): string {
  const parts: string[] = [];
  if (resolved.date) parts.push(`תאריך → ${pretty(resolved.date)} (${DateTime.fromISO(resolved.date).setLocale("he").toFormat("EEEE")})`);
  if (change.shiftDays) parts.push(`הזזת התאריך ב-${Math.abs(change.shiftDays)} ימים ${change.shiftDays > 0 ? "קדימה" : "אחורה"}`);
  if (change.status) parts.push(`סטטוס → "${change.status}"`);
  if (change.priority) parts.push(`תעדוף → "${change.priority}"`);
  if (resolved.assigneeName) parts.push(`אחראי/ת → ${resolved.assigneeName}`);
  return parts.join(" · ");
}

function describeItemChange(it: PlanItem): string {
  const parts: string[] = [];
  if (it.after.date !== undefined) parts.push(`${it.before.date ? pretty(it.before.date) : "בלי תאריך"} → ${pretty(it.after.date)}`);
  if (it.after.status !== undefined) parts.push(`${it.before.status || "בלי סטטוס"} → ${it.after.status}`);
  if (it.after.priority !== undefined) parts.push(`${it.before.priority || "בלי תעדוף"} → ${it.after.priority}`);
  if (it.after.assigneeIds !== undefined) parts.push("אחראי/ת מוחלף/ת");
  return parts.join(" · ");
}

export async function prepareBulkUpdate(
  user: IdentifiedUser,
  ctx: BulkContext,
  input: { resultSetId?: string; change: BulkChangeInput },
  deps: BulkUpdateDeps = {},
): Promise<BulkStepResult> {
  const doRead = deps.readItemsForVerification ?? readItemsForVerification;
  const doGetOwners = deps.getProjectOwnerIds ?? getProjectOwnerIds;
  const doGetLabels = deps.getColumnLabels ?? getColumnLabels;

  const rs =
    input.resultSetId && input.resultSetId !== "last"
      ? getResultSet(input.resultSetId, user.key, ctx.sessionId)
      : getLatestResultSet(user.key, ctx.sessionId);
  if (!rs) return { ok: false, error: "אין קבוצת תוצאות בשיחה הזו — קודם קרא query_records עם הסינון המבוקש." };
  if (!rs.complete) {
    return { ok: false, error: "השליפה האחרונה הייתה חלקית — אסור לעדכן קבוצה לא מלאה. הרץ שוב query_records ורק אם השליפה מלאה אפשר להמשיך." };
  }
  if (rs.records.length === 0) return { ok: false, error: "קבוצת התוצאות ריקה — אין מה לעדכן." };
  // עסקאות/התחייבויות (תצוגת "כל מה שיש לי") — קריאה בלבד; לא מעדכנים קבוצה שחלק ממנה לא נתמך בשקט
  const readOnly = rs.records.filter((r) => r.kind === "deal" || r.kind === "commitment");
  if (readOnly.length) {
    return {
      ok: false,
      error: `בקבוצה יש ${readOnly.length} עסקאות/התחייבויות — עדכון קבוצתי נתמך רק למשימות וללידים. שאל את המשתמש אם לעדכן רק את המשימות/הלידים (query_records מחדש עם recordType מתאים).`,
    };
  }
  if (rs.records.length > BULK_MAX_ITEMS) {
    return { ok: false, error: `נמצאו ${rs.records.length} רשומות — יותר מ-${BULK_MAX_ITEMS} בעדכון אחד. בקש מהמשתמש לצמצם את הסינון.` };
  }

  const change = input.change ?? {};
  const requested = ["dueDate", "shiftDays", "status", "priority", "assignee"].filter((k) => (change as Record<string, unknown>)[k] !== undefined && (change as Record<string, unknown>)[k] !== "");
  if (!requested.length) return { ok: false, error: "לא צוין מה לשנות (תאריך / סטטוס / תעדוף / אחראי)." };
  if (change.dueDate && change.shiftDays) return { ok: false, error: "אי אפשר גם לקבוע תאריך וגם להזיז — שאל את המשתמש למה התכוון." };
  if (change.shiftDays !== undefined && (!Number.isInteger(change.shiftDays) || change.shiftDays === 0 || Math.abs(change.shiftDays) > 365)) {
    return { ok: false, error: "shiftDays חייב להיות מספר ימים שלם (לא 0)." };
  }

  let targetDate: string | undefined;
  if (change.dueDate) {
    targetDate = resolveSingleDay(change.dueDate, ctx.now) ?? undefined;
    if (!targetDate) return { ok: false, error: `לא הבנתי את התאריך "${change.dueDate}" כיום יחיד — שאל את המשתמש לתאריך מדויק (למשל 25/10). אל תנחש (למשל "אחרי החג").` };
  }

  let assignee: IdentifiedUser | undefined;
  if (change.assignee) {
    try {
      const people = resolvePeople(user, [change.assignee]);
      if (people.length !== 1) throw new Error(`"${change.assignee}" אינו אדם יחיד — שאל למי להעביר.`);
      assignee = people[0]!;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (!assignee.mondayUserId) return { ok: false, error: `ל${assignee.name} אין חשבון Monday פעיל — אי אפשר להקצות אליו/ה.` };
  }

  // snapshot טרי מ-Monday — לא סומכים על מה שנשלף בשאילתה (יכול להיות לפני כמה דקות)
  let snaps: Map<string, ItemSnapshot>;
  try {
    snaps = await doRead(rs.records.map((r) => r.itemId));
  } catch {
    return { ok: false, error: "לא הצלחתי לקרוא את הרשומות מחדש מ-Monday — לא הוכנה תוכנית. נסה שוב בעוד רגע." };
  }

  // תוויות פר-סוג — נפתרות פעם אחת לכל סוג, לא לכל רשומה
  const kinds = [...new Set([...snaps.values()].map((s) => s.kind))];
  const statusByKind = new Map<BulkItemKind, string>();
  const priorityByKind = new Map<BulkItemKind, string>();
  try {
    for (const k of kinds) {
      if (change.status) statusByKind.set(k, await resolveStatusFor(k, change.status, doGetLabels));
      if (change.priority) {
        if (!isTaskKind(k)) throw new Error("ללידים אין עמודת תעדוף.");
        priorityByKind.set(k, await resolvePriorityFor(k, change.priority, doGetLabels));
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // בעלי פרויקטים — רק כשצריך (מנהל/ת פרויקט על משימה של אחר), פעם אחת לכל פרויקט
  const projectOwners = new Map<string, string[]>();
  const needsScope = !(user.role === "owner" || user.role === "admin") && userCan(user, "task:manage");
  if (needsScope) {
    const projectIds = new Set(
      [...snaps.values()]
        .filter((s) => isTaskKind(s.kind) && s.projectId && !(user.mondayUserId && s.assigneeIds.includes(user.mondayUserId)))
        .map((s) => s.projectId!),
    );
    try {
      for (const pid of projectIds) projectOwners.set(pid, await doGetOwners(pid));
    } catch {
      return { ok: false, error: "לא הצלחתי לאמת את מנהלי הפרויקטים מול Monday — לא הוכנה תוכנית." };
    }
  }

  const items: PlanItem[] = [];
  const excluded: ExcludedItem[] = [];
  for (const rec of rs.records) {
    const snap = snaps.get(rec.itemId);
    if (!snap) {
      excluded.push({ itemId: rec.itemId, name: rec.name, reason: "לא נמצאה ב-Monday" });
      continue;
    }
    const cols = BULK_COLUMNS[snap.kind];
    const after: PlannedValues = {};
    const columnValues: Record<string, unknown> = {};

    if (targetDate || change.shiftDays) {
      const newDate = targetDate ?? (snap.date ? shiftIsoDate(snap.date, change.shiftDays!) : undefined);
      if (!newDate) {
        excluded.push({ itemId: rec.itemId, name: snap.name, reason: "אין לה תאריך להזיז" });
        continue;
      }
      if (newDate !== snap.date) {
        after.date = newDate;
        columnValues[cols.date] = { date: newDate };
      }
    }
    const st = statusByKind.get(snap.kind);
    if (st && st !== snap.status) {
      after.status = st;
      columnValues[cols.status] = { label: st };
    }
    const pr = priorityByKind.get(snap.kind);
    if (pr && pr !== snap.priority) {
      after.priority = pr;
      columnValues[cols.priority!] = { label: pr };
    }
    if (assignee && !(snap.assigneeIds.length === 1 && snap.assigneeIds[0] === assignee.mondayUserId)) {
      after.assigneeIds = [assignee.mondayUserId!];
      columnValues[cols.people] = { personsAndTeams: [{ id: Number(assignee.mondayUserId), kind: "person" }] };
    }
    if (!Object.keys(columnValues).length) {
      excluded.push({ itemId: rec.itemId, name: snap.name, reason: "כבר במצב המבוקש" });
      continue;
    }
    const auth = authorizeBulkItem(user, snap, after, projectOwners);
    if (!auth.ok) {
      excluded.push({ itemId: rec.itemId, name: snap.name, reason: auth.reason });
      continue;
    }
    items.push({ itemId: rec.itemId, kind: snap.kind, boardId: snap.boardId, name: snap.name, before: snap, after, columnValues });
  }

  const changeText = describeChange(change, { date: targetDate, assigneeName: assignee?.name });
  if (!items.length) {
    const why = excluded.slice(0, 10).map((e) => `• ${e.name} — ${e.reason}`).join("\n");
    return { ok: false, error: `אין אף רשומה שאפשר לעדכן (${changeText}):\n${why}${excluded.length > 10 ? `\n…ועוד ${excluded.length - 10}` : ""}` };
  }

  const stored: StoredPlanItems = { items, excluded, filtersText: rs.filtersText, assigneeName: assignee?.name };
  const planId = savePlan({
    userKey: user.key,
    sessionId: ctx.sessionId,
    resultSetId: rs.id,
    recordType: rs.recordType,
    change: { ...change, resolvedDate: targetDate },
    changeText,
    items: stored,
    createdTurn: ctx.turnId,
    expiresAt: ctx.now.plus({ minutes: BULK_PLAN_TTL_MINUTES }).toUTC().toISO()!,
  });

  logger.info(
    { user: user.key, planId, recordType: rs.recordType, planned: items.length, excluded: excluded.length, fields: requested },
    "עדכון קבוצתי — תוכנית הוכנה, ממתינה לאישור",
  );

  const noun = rs.recordType === "tasks" ? "משימות" : rs.recordType === "leads" ? "לידים" : "רשומות";
  const lines = [
    "📋 תצוגה מקדימה — עדכון קבוצתי (עדיין לא בוצע שום שינוי)",
    `סינון: ${rs.filtersText}`,
    `שינוי: ${changeText}`,
    "",
    `יעודכנו ${items.length} ${noun}:`,
    ...items.map((it, i) => `${i + 1}. ${it.name} — ${describeItemChange(it)}`),
  ];
  if (excluded.length) {
    lines.push("", `לא יעודכנו (${excluded.length}):`, ...excluded.map((e) => `• ${e.name} — ${e.reason}`));
  }
  lines.push("", `לאשר? כתוב/כתבי "כן" לביצוע, או תאר/י מה לשנות. (התצוגה בתוקף ${BULK_PLAN_TTL_MINUTES} דקות)`);
  return { ok: true, text: lines.join("\n"), planId };
}

// ---------------------------------------------------------------------------
// 2+3. אישור → אימות → ביצוע
// ---------------------------------------------------------------------------

function planContent(plan: StoredBulkPlan): StoredPlanItems {
  return plan.items as StoredPlanItems;
}

export function formatReport(report: BulkReport, recordType: string): string {
  const noun = recordType === "tasks" ? "משימות" : "לידים";
  const total = report.updated.length + report.failed.length + report.notAttempted.length;
  const lines = [
    report.failed.length || report.notAttempted.length
      ? `⚠️ העדכון הקבוצתי הושלם חלקית: עודכנו ${report.updated.length} מתוך ${total} ${noun}.`
      : `✅ עודכנו ${report.updated.length} ${noun} בהצלחה.`,
  ];
  if (report.failed.length) {
    lines.push("", `נכשלו (${report.failed.length}):`, ...report.failed.map((f) => `• ${f.name} — ${f.error}`));
  }
  if (report.notAttempted.length) {
    lines.push("", `לא בוצעו (${report.notAttempted.length}):`, ...report.notAttempted.map((f) => `• ${f.name} — ${f.reason}`));
  }
  if (report.excluded.length) {
    lines.push("", `לא נכללו בעדכון מלכתחילה (${report.excluded.length}):`, ...report.excluded.map((e) => `• ${e.name} — ${e.reason}`));
  }
  return lines.join("\n");
}

export async function confirmBulkUpdate(
  user: IdentifiedUser,
  ctx: BulkContext & { latestUserMessage: string },
  input: { planId?: string },
  deps: BulkUpdateDeps = {},
): Promise<BulkStepResult> {
  const doRead = deps.readItemsForVerification ?? readItemsForVerification;
  const doWrite = deps.setItemColumnValues ?? setItemColumnValues;
  const doNote = deps.addTaskNote ?? addTaskNote;

  const plan =
    input.planId && input.planId !== "last"
      ? getPlan(input.planId, user.key, ctx.sessionId)
      : getLatestPendingPlan(user.key, ctx.sessionId);
  if (!plan) return { ok: false, error: "אין עדכון קבוצתי שממתין לאישור בשיחה הזו." };

  switch (plan.status) {
    case "executed":
      // אישור חוזר / retry — לא מבצעים שוב, מחזירים את הדוח השמור
      return { ok: true, executed: false, text: `העדכון הזה כבר בוצע — לא ביצעתי אותו שוב.\n\n${formatReport(plan.report as BulkReport, plan.recordType)}` };
    case "executing":
      return { ok: false, error: "העדכון הזה כבר בביצוע (או נקטע באמצע) — לא מריץ אותו שוב. בדוק את הרשומות ב-Monday לפני ניסיון נוסף." };
    case "stale":
      return { ok: false, error: "הרשומות השתנו מאז התצוגה — צריך להכין תצוגה מחדש (prepare_bulk_update) ולקבל אישור חדש." };
    case "cancelled":
      return { ok: false, error: "התוכנית הזו בוטלה או הוחלפה בתצוגה חדשה יותר." };
    case "expired":
      return { ok: false, error: "התצוגה פגה — צריך להכין אותה מחדש." };
  }

  if (DateTime.fromISO(plan.expiresAt) < ctx.now) {
    casPlanStatus(plan.id, "awaiting_confirmation", "expired");
    return { ok: false, error: `התצוגה פגה (יותר מ-${BULK_PLAN_TTL_MINUTES} דקות) — צריך להכין אותה מחדש ולאשר שוב.` };
  }
  if (plan.createdTurn === ctx.turnId) {
    return { ok: false, error: "אסור לבצע באותה הודעה שבה הוכנה התצוגה — הצג אותה למשתמש וחכה לאישור מפורש ממנו." };
  }
  if (!isExplicitConfirmation(ctx.latestUserMessage)) {
    return {
      ok: false,
      error: "ההודעה האחרונה של המשתמש אינה אישור מפורש. אם ביקש שינוי — הכן תצוגה חדשה (query_records/prepare_bulk_update); אחרת שאל אם לבצע.",
    };
  }
  if (!casPlanStatus(plan.id, "awaiting_confirmation", "executing")) {
    return { ok: false, error: "העדכון כבר אושר/בוצע במקביל — לא מריץ אותו פעם נוספת." };
  }

  const content = planContent(plan);
  let current: Map<string, ItemSnapshot>;
  try {
    current = await doRead(content.items.map((i) => i.itemId));
  } catch {
    casPlanStatus(plan.id, "executing", "awaiting_confirmation");
    return { ok: false, error: "לא הצלחתי לאמת את הרשומות מול Monday רגע לפני הביצוע — לא בוצע שום שינוי. אפשר לנסות לאשר שוב בעוד רגע." };
  }

  const changed = content.items
    .map((it) => ({ it, diffs: snapshotDiff(it.before, current.get(it.itemId)) }))
    .filter((x) => x.diffs.length);
  if (changed.length) {
    finalizePlan(plan.id, "stale", { changed: changed.map((c) => ({ itemId: c.it.itemId, diffs: c.diffs })) });
    logger.info({ user: user.key, planId: plan.id, changed: changed.length }, "עדכון קבוצתי — נעצר, רשומות השתנו מאז התצוגה");
    return {
      ok: false,
      error: [
        `לא בוצע שום שינוי: ${changed.length} רשומות השתנו ב-Monday מאז התצוגה:`,
        ...changed.slice(0, 15).map((c) => `• ${c.it.name} — ${c.diffs.join(", ")}`),
        "צריך להכין תצוגה מחדש ולקבל אישור חדש מהמשתמש.",
      ].join("\n"),
    };
  }

  const report: BulkReport = { updated: [], failed: [], notAttempted: [], excluded: content.excluded };
  for (const it of content.items) {
    try {
      await doWrite(it.boardId, it.itemId, it.columnValues);
      report.updated.push({ itemId: it.itemId, name: it.name });
      if (it.after.assigneeIds) {
        // תיעוד מי ביצע (כל כתיבה ל-Monday על חשבון ה-API) — best-effort, לא מכשיל את הרשומה
        try {
          await doNote(it.itemId, `👤 אחראי/ת שונה/תה ל${content.assigneeName ?? "אחר/ת"} — ע"י ${user.name} דרך עדכון קבוצתי בעוזר התפעולי`);
        } catch (err) {
          logger.warn({ err, planId: plan.id, itemId: it.itemId }, "עדכון קבוצתי — תיעוד Update נכשל (הכתיבה עצמה הצליחה)");
        }
      }
    } catch (err) {
      report.failed.push({ itemId: it.itemId, name: it.name, error: (err as Error).message.slice(0, 200) });
    }
    savePlanProgress(plan.id, report);
  }
  finalizePlan(plan.id, "executed", report);
  logger.info(
    { user: user.key, planId: plan.id, recordType: plan.recordType, updated: report.updated.length, failed: report.failed.length, excluded: report.excluded.length },
    "עדכון קבוצתי בוצע",
  );
  return { ok: true, executed: true, text: formatReport(report, plan.recordType), planId: plan.id };
}

export function cancelBulkUpdate(user: IdentifiedUser, ctx: { sessionId: string }): BulkStepResult {
  const n = cancelPendingPlans(user.key, ctx.sessionId);
  return n ? { ok: true, text: "בוטל — לא בוצע שום שינוי." } : { ok: false, error: "אין עדכון קבוצתי שממתין לאישור." };
}

/** שורות הקשר לשיחה (נכנסות לחלק המשתנה של ה-system prompt) — רק כשיש מצב פעיל. */
export function buildBulkContextLines(userKey: string, sessionId: string, now: DateTime): string[] {
  const lines: string[] = [];
  const rs = getLatestResultSet(userKey, sessionId);
  const plan = getLatestPendingPlan(userKey, sessionId);
  const fresh = (iso: string) => DateTime.fromSQL(iso, { zone: "utc" }) > now.minus({ hours: 3 });
  if (rs && fresh(rs.createdAt)) {
    lines.push(
      `• קבוצת התוצאות האחרונה בשיחה: ${rs.records.length} ${rs.recordType === "tasks" ? "משימות" : "לידים"} — ${rs.filtersText}${rs.complete ? "" : " (⚠️ חלקית)"}. ` +
        "בקשת המשך שמשנה את הסינון ('חוץ מ...', 'רק של...') → query_records עם base='last' ורק השינוי. בקשה לפעול עליהן ('תעביר את כולן...') → prepare_bulk_update.",
    );
  }
  if (plan && DateTime.fromISO(plan.expiresAt) > now) {
    lines.push(
      `• עדכון קבוצתי ממתין לאישור (${plan.id}): ${planContent(plan).items.length} רשומות — ${plan.changeText}. ` +
        "אישור מפורש של המשתמש → confirm_bulk_update. בקשת שינוי → הכנה מחדש. 'בטל' → cancel_bulk_update.",
    );
  }
  return lines.length ? ["", "מצב פעולות קבוצתיות בשיחה (נתון מערכת):", ...lines] : [];
}

