/**
 * סיכום סוף יום למוטי (18:00, א׳–ה׳) — תמונת עבודה: מה הסתיים / מה בעבודה / חריגים / אישורים.
 *
 * דטרמיניסטי לגמרי — בלי קריאת AI (בדיוק כמו weeklyReport.ts). הפרדת אחריות (audit 2026-09-17,
 * מאושרת):
 *   • Monday = Source of Truth ל"הסתיים היום" (opsActivity.ts, activity_logs) ו"עדיין בעבודה"
 *     (officeState.ts — status==="בעבודה").
 *   • DB המקומי = Source of Truth להתחייבויות/דחיות/scope-change/ממצאי בקרה/אישורי מוטי — לא נוגעים
 *     ב-Policy Engine, ב-Control Engine, בחוקי הדחיות, או במנגנון האישורים; רק קוראים מהם.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { getOfficeState, type OfficeState } from "./officeState.js";
import {
  fetchCompletedToday,
  type CompletedTodayItem,
  type FetchCompletedTodayDeps,
} from "../integrations/monday/opsActivity.js";
import { listActiveFindings, type StoredFinding } from "../db/repositories/controlFindings.js";
import { deferralEventsSince } from "../db/repositories/findingEvents.js";
import { addNotification, notificationsByKindSince, supersedeKind, type Notification } from "../db/repositories/notifications.js";
import { listApprovalsForManager, type StoredApproval } from "../db/repositories/managerApprovals.js";
import { resolveUserByKey, resolveUsersByAssigneeText } from "../identity/index.js";
import { publishNotificationLive } from "./notificationBus.js";
import { logger } from "../utils/logger.js";

const IN_PROGRESS_STATUS = "בעבודה";
const SECTION_CAP = 8;
const NON_PROJECT_CONTEXT = new Set(["", "משימת משרד", "פרויקט לא מקושר"]);

/** control_findings/finding_events/notifications/manager_approvals נכתבים ב-datetime('now') של
 *  SQLite — UTC, פורמט "YYYY-MM-DD HH:MM:SS" בלי offset. חייבים להשוות מול cutoff באותו פורמט
 *  בדיוק (לא .toISO() — זה ISO עם offset, פורמט אחר לגמרי, והשוואת מחרוזות הייתה יוצאת שגויה). */
function sqlUtcCutoff(dt: DateTime): string {
  return dt.toUTC().toFormat("yyyy-MM-dd HH:mm:ss");
}

function addToGroup(map: Map<string, string[]>, name: string, label: string): void {
  const arr = map.get(name);
  if (arr) arr.push(label);
  else map.set(name, [label]);
}

function completedLabel(item: CompletedTodayItem): string {
  return item.project && !NON_PROJECT_CONTEXT.has(item.project) ? `${item.taskName} (${item.project})` : item.taskName;
}

/**
 * מקבץ לפי עובד — פותר את טקסט עמודת האחראי (יכול לכלול כמה שמות, "מוטי, דוב שפירא") מול ספר
 * הצוות (resolveUsersByAssigneeText, אותו helper שמשמש את כל שאר המערכת). משימה משותפת מוצגת
 * תחת כל אחד מהאחראים. טקסט שלא זוהה מוצג כמו שהוא, כדי לא לאבד מידע בשקט.
 */
function groupCompletedByPerson(items: CompletedTodayItem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const label = completedLabel(item);
    const members = resolveUsersByAssigneeText(item.assignees);
    if (members.length === 0) addToGroup(map, item.assignees || "לא משויך", label);
    else for (const m of members) addToGroup(map, m.name, label);
  }
  return map;
}

/**
 * "עדיין בעבודה" — Monday הוא הקובע: אך ורק status==="בעבודה" בפועל, לא תאריך יעד ולא מה שדווח
 * בצ'אט. officeState.perPerson כבר מפריד פר-חבר-צוות אמיתי (fetchUserOpsTasks מסונן לפי mondayUserId
 * שלו) — לא צריך לפרש טקסט אחראי כאן.
 */
export function groupInProgressByPerson(office: OfficeState): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { member, tasks } of office.perPerson) {
    const inProgress = tasks.filter((t) => t.status === IN_PROGRESS_STATUS);
    if (inProgress.length === 0) continue;
    map.set(
      member.name,
      inProgress.map((t) => (t.context && !NON_PROJECT_CONTEXT.has(t.context) ? `${t.name} (${t.context})` : t.name)),
    );
  }
  return map;
}

function cap(arr: string[], n: number = SECTION_CAP): string[] {
  return arr.length > n ? [...arr.slice(0, n), `…ועוד ${arr.length - n}`] : arr;
}

interface AwaitingDecisionContext {
  missedCommitment?: boolean;
  employeeName?: string;
  taskName?: string;
  hoursPassed?: number | null;
  from?: string;
}

export interface EodSummarySections {
  now: DateTime;
  completedByPerson: Map<string, string[]>;
  inProgressByPerson: Map<string, string[]>;
  exceptions: string[];
  deferralsAndCommitments: string[];
  pendingApprovals: string[];
  decidedApprovalsNote: string | null;
}

/** רינדור טהור — לא קורא DB/Monday, לכן נבדק ישירות. לא מציג section ריק (דרישה מפורשת). */
export function renderEodSummaryText(s: EodSummarySections): string {
  const sections: string[] = [];

  const personBlock = (title: string, map: Map<string, string[]>) => {
    if (map.size === 0) return;
    const body = [...map.entries()]
      .map(([name, tasks]) => `${name}:\n${tasks.map((t) => `• ${t}`).join("\n")}`)
      .join("\n\n");
    sections.push(`${title}\n${body}`);
  };

  personBlock("✅ הסתיים היום", s.completedByPerson);
  personBlock("🔄 עדיין בעבודה", s.inProgressByPerson);

  if (s.exceptions.length) sections.push(`⚠️ דורש תשומת לב\n${s.exceptions.map((x) => `• ${x}`).join("\n")}`);
  if (s.deferralsAndCommitments.length) {
    sections.push(`⏰ דחיות והתחייבויות\n${s.deferralsAndCommitments.map((x) => `• ${x}`).join("\n")}`);
  }
  if (s.pendingApprovals.length || s.decidedApprovalsNote) {
    const lines = s.pendingApprovals.map((x) => `• ${x}`);
    if (s.decidedApprovalsNote) lines.push(s.decidedApprovalsNote);
    sections.push(`🔔 ממתין לאישור מוטי\n${lines.join("\n")}`);
  }

  if (sections.length === 0) {
    return `📋 סיכום סוף יום\n\nסיכום היום: לא נרשמה פעילות או חריגה הדורשת סיכום.`;
  }
  return `📋 סיכום סוף יום (${s.now.toFormat("dd/MM")})\n\n${sections.join("\n\n")}`;
}

export interface EodSummaryDeps {
  fetchCompletedToday?: (nowLocal: DateTime, deps?: FetchCompletedTodayDeps) => ReturnType<typeof fetchCompletedToday>;
  getOfficeState?: typeof getOfficeState;
}

export interface EodSummaryResult {
  generatedAt: string;
  text: string;
}

export async function buildEndOfDaySummary(deps: EodSummaryDeps = {}): Promise<EodSummaryResult> {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const doFetchCompletedToday = deps.fetchCompletedToday ?? fetchCompletedToday;
  const doGetOfficeState = deps.getOfficeState ?? getOfficeState;
  const cutoff = sqlUtcCutoff(now.startOf("day"));

  // Monday (completed + in-progress) — best-effort: תקלת Monday זמנית לא מפילה את שאר הסיכום,
  // רק משמיטה את הסעיף שלה (אותו עיקרון כמו calendarTimeout ב-escalation.ts).
  const [completedResult, officeResult] = await Promise.allSettled([doFetchCompletedToday(now), doGetOfficeState()]);
  let completed: CompletedTodayItem[] = [];
  if (completedResult.status === "fulfilled") completed = completedResult.value;
  else logger.error({ err: completedResult.reason }, "EOD summary: fetchCompletedToday נכשל — סעיף 'הסתיים היום' יידלג");

  let office: OfficeState | null = null;
  if (officeResult.status === "fulfilled") office = officeResult.value;
  else logger.error({ err: officeResult.reason }, "EOD summary: getOfficeState נכשל — סעיף 'עדיין בעבודה' יידלג");

  const completedByPerson = groupCompletedByPerson(completed);
  const inProgressByPerson = office ? groupInProgressByPerson(office) : new Map<string, string[]>();

  // ---- ⏰ דחיות והתחייבויות (DB מקומי — Source of Truth) ----
  const usedFindingKeys = new Set<string>();
  const deferralAndCommitmentLines: string[] = [];

  for (const d of deferralEventsSince(cutoff)) {
    const who = (d.byUserKey && resolveUserByKey(d.byUserKey)?.name) || d.who;
    const prettyDate = d.snoozeUntil ? DateTime.fromISO(d.snoozeUntil, { zone: env.TIMEZONE }).toFormat("dd/MM") : "?";
    deferralAndCommitmentLines.push(`${who} — ${d.headline} → נדחה ל-${prettyDate}${d.scopeChange ? " (שינוי היקף)" : ""}`);
    usedFindingKeys.add(d.findingKey);
  }

  const moti = resolveUserByKey("moti");
  const awaitingToday: Notification[] = moti ? notificationsByKindSince(moti.key, "awaiting_decision", cutoff) : [];
  const isMissedCommitment = (n: Notification) => (n.context as AwaitingDecisionContext | null)?.missedCommitment === true;

  for (const n of awaitingToday.filter(isMissedCommitment)) {
    const ctx = n.context as AwaitingDecisionContext | null;
    deferralAndCommitmentLines.push(`${ctx?.employeeName ?? "עובד"} — "${ctx?.taskName ?? n.itemId ?? "משימה"}" (התחייבות "אסיים היום" לא קוימה)`);
    if (n.findingKey) usedFindingKeys.add(n.findingKey);
  }

  // ---- ⚠️ דורש תשומת לב — לא כפילות למה שכבר הוצג למעלה (usedFindingKeys) ----
  const exceptionLines: string[] = [];
  const openFindings: StoredFinding[] = listActiveFindings()
    .filter((f) => f.severity !== "normal" && !usedFindingKeys.has(f.findingKey))
    .sort((a, b) => (a.severity === "critical" ? -1 : 0) - (b.severity === "critical" ? -1 : 0));
  for (const f of openFindings) exceptionLines.push(`${f.headline} — ${f.who}`);

  for (const n of awaitingToday.filter((x) => !isMissedCommitment(x) && !(x.findingKey && usedFindingKeys.has(x.findingKey)))) {
    const ctx = n.context as AwaitingDecisionContext | null;
    if (ctx?.employeeName) {
      exceptionLines.push(
        `${ctx.employeeName} לא הגיב/ה לפניית הבקרה על "${ctx.taskName ?? ""}"${ctx.hoursPassed != null ? ` (כ-${ctx.hoursPassed} שעות)` : ""}`,
      );
    } else if (ctx?.from) {
      exceptionLines.push(`${resolveUserByKey(ctx.from)?.name ?? ctx.from} ממתין/ה להחלטתך על "${ctx.taskName ?? ""}"`);
    } else {
      exceptionLines.push(n.body.length > 100 ? `${n.body.slice(0, 100)}…` : n.body);
    }
  }

  // ---- 🔔 ממתין לאישור מוטי (manager_approvals הקיים — לא מנגנון חדש) ----
  const allApprovals: StoredApproval[] = moti ? listApprovalsForManager(moti.key, 100) : [];
  const pendingApprovals = allApprovals.filter((a) => a.status === "pending" || a.status === "pending_instruction");
  const pendingLines = pendingApprovals.map((a) => {
    const requester = resolveUserByKey(a.requestedBy)?.name ?? a.requestedBy;
    const kindLabel = a.kind === "deferral" ? "דחייה" : a.kind === "cancellation" ? "ביטול" : "שינוי אחראי";
    return `${kindLabel}: "${a.taskName ?? a.itemId ?? ""}" — ${requester}`;
  });
  const decidedToday = allApprovals.filter((a) => (a.status === "approved" || a.status === "rejected") && a.decidedAt && a.decidedAt >= cutoff);
  const decidedNote = decidedToday.length
    ? `(היום הוכרעו גם: ${decidedToday.filter((a) => a.status === "approved").length} אושרו · ${decidedToday.filter((a) => a.status === "rejected").length} נדחו)`
    : null;

  const text = renderEodSummaryText({
    now,
    completedByPerson,
    inProgressByPerson,
    exceptions: cap(exceptionLines),
    deferralsAndCommitments: cap(deferralAndCommitmentLines),
    pendingApprovals: cap(pendingLines),
    decidedApprovalsNote: decidedNote,
  });

  if (moti) {
    supersedeKind(moti.key, "eod_summary"); // סיכום היום מחליף את של אתמול, אותו pattern כמו briefing/weekly
    const notifId = addNotification(moti.key, "eod_summary", text);
    publishNotificationLive({
      userKey: moti.key,
      id: notifId,
      kind: "eod_summary",
      body: text,
      findingKey: null,
      itemId: null,
      itemSource: null,
      context: null,
      createdAt: now.toISO()!,
    });
  }

  logger.info({ completed: completed.length, exceptions: exceptionLines.length, pendingApprovals: pendingLines.length }, "סיכום סוף יום: הסתיים");
  return { generatedAt: now.toISO() ?? "", text };
}
