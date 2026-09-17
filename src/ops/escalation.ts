/**
 * הסבב היומי של מנוע הבקרה (שלב 4): סריקה → שמירה → הסלמה → תדריך בוקר למוטי.
 *
 * הסלמה אגרסיבית (CLAUDE.md סעיף 3):
 *   יום עבודה 1 בלי תזוזה → תזכורת לעובד (בצ'אט שלו)
 *   יום עבודה 2            → למנהל הפרויקט
 *   יום עבודה 3 / קריטי    → מוטי (בנוסף לתדריך הבוקר שהוא מקבל ממילא)
 *
 * "בלי תזוזה" = אותו ממצא (אותו finding_key) עדיין מופיע בסריקה. ברגע שהוא נעלם → נפתר, מתאפס.
 * ספי הימים v1 — לכוונון אחרי הרצה.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  listActiveFindings,
  resolveStaleFindings,
  setEscalation,
  upsertFinding,
  type StoredFinding,
} from "../db/repositories/controlFindings.js";
import { addNotification, hasUnseenNotificationForKind, supersedeKind } from "../db/repositories/notifications.js";
import {
  isResolvedByReply,
  lastResponseAt,
  recordFindingEvent,
  snoozedUntil,
} from "../db/repositories/findingEvents.js";
import { enqueueWhatsapp } from "../db/repositories/whatsappOutbox.js";
import { publishNudge } from "./nudgeBus.js";
import { resolveUserByKey, resolveUsersByAssigneeText } from "../identity/index.js";
import { listCalendarEvents } from "../integrations/google/calendar.js";
import { logger } from "../utils/logger.js";
import { runControlScan, type Severity } from "./controlScan.js";
import { runCrmScan } from "./crmScan.js";
import { getOfficeState } from "./officeState.js";
import { scheduleInitialNudgeFollowup, type ScheduleNoResponseInput } from "./followups.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";

/**
 * ימי עבודה (א׳–ה׳) שחלפו בין שני מועדים, לא כולל היום של `from`.
 * חשוב: משווים לפי יומן אזור הזמן של המשרד. אם משאירים את ההשוואה על מופעי DateTime עם offset
 * שונה (השרת רץ ב-UTC, ה-firstSeen נשמר עם +03:00) — היום האחרון נחתך והספירה יוצאת נמוכה ביום.
 */
function businessDaysBetween(from: DateTime, to: DateTime): number {
  let d = from.setZone(env.TIMEZONE).startOf("day").plus({ days: 1 });
  const end = to.setZone(env.TIMEZONE).startOf("day");
  let count = 0;
  while (d.toMillis() <= end.toMillis()) {
    if (d.weekday !== 5 && d.weekday !== 6) count++; // 5=Fri 6=Sat
    d = d.plus({ days: 1 });
  }
  return count;
}

function targetLevel(severity: Severity, businessDaysStale: number): number {
  if (severity === "critical") return 3;
  if (businessDaysStale >= 3) return 3;
  if (businessDaysStale >= 2) return 2;
  if (businessDaysStale >= 1) return 1;
  return 0;
}

/**
 * ctx מובנה להתראת escalation (רמה 2/3) — אותה צורה בדיוק כמו ה-nudge ברמה 1 (למעלה), כדי
 * שה-UI יוכל לפתוח שיחה עם ה-context הנכון (ר' openNudgeInChat/ACTIONABLE_NOTIF_KINDS ב-ui.html).
 * רק שדות שכבר קיימים על ה-finding עצמו (מ-upsertFinding) — בלי קריאה חדשה ל-Monday ובלי ניחוש.
 */
export function escalationNotifContext(finding: StoredFinding) {
  return {
    itemId: finding.itemId ?? undefined,
    itemSource: finding.itemSource ?? undefined,
    context: {
      taskName: finding.headline,
      project: finding.project ?? undefined,
      currentDueDateISO: finding.dueDate ?? null,
    },
  };
}

export interface EscalationDecision {
  /** דלג לגמרי (העובד סגר / נדחה) */
  skip: boolean;
  skipReason?: "resolved_by_reply" | "snoozed";
  /** רמת ההסלמה שאליה צריך להגיע כרגע (0 = לא צריך) */
  target: number;
  /** ימי עבודה "בלי תזוזה" — מהתגובה האחרונה, לא מ-first_seen */
  stale: number;
}

/**
 * מה לעשות עם ממצא פעיל, בהתחשב באירועי ה-finding_events (תגובות עובד, דחיות, סגירות).
 * טהורה מבחינת Monday — קוראת רק DB. מופרדת כדי שאפשר לבדוק את לוגיקת הלולאה בלי סריקה.
 */
export function escalationDecision(
  finding: Pick<StoredFinding, "findingKey" | "severity" | "firstSeen" | "escalationLevel">,
  now: DateTime,
  deps: {
    isResolvedByReply: (k: string) => boolean;
    snoozedUntil: (k: string) => string | null;
    lastResponseAt: (k: string) => string | null;
  } = { isResolvedByReply, snoozedUntil, lastResponseAt },
): EscalationDecision {
  if (deps.isResolvedByReply(finding.findingKey)) {
    return { skip: true, skipReason: "resolved_by_reply", target: 0, stale: 0 };
  }
  const snooze = deps.snoozedUntil(finding.findingKey);
  if (snooze && DateTime.fromISO(snooze, { zone: env.TIMEZONE }).startOf("day") >= now.startOf("day")) {
    return { skip: true, skipReason: "snoozed", target: 0, stale: 0 };
  }
  const firstSeenDt = DateTime.fromISO(finding.firstSeen);
  const respondedRaw = deps.lastResponseAt(finding.findingKey);
  // תגובות נשמרות ב-datetime('now') של SQLite = "YYYY-MM-DD HH:MM:SS" ב-UTC.
  const respondedDt = respondedRaw
    ? (DateTime.fromSQL(respondedRaw, { zone: "utc" }).isValid
        ? DateTime.fromSQL(respondedRaw, { zone: "utc" })
        : DateTime.fromISO(respondedRaw))
    : null;
  const clockStart = respondedDt && respondedDt > firstSeenDt ? respondedDt : firstSeenDt;
  const stale = businessDaysBetween(clockStart, now);
  const target = targetLevel(finding.severity, stale);
  return { skip: false, target, stale };
}

/**
 * מסנן ממצאים ל"מה שמוצג בדוחות למוטי" (תדריך בוקר / סיכום סוף יום / chronic בדוח השבועי) —
 * לא כפילות של לוגיקת snooze/resolved_by_reply, רק שימוש ב-escalationDecision הקיים (audit
 * 2026-09-17: שלושת הדוחות בנו את הרשימה שלהם ישירות מ-listActiveFindings()/chronicFindings()
 * בלי לעבור דרך escalationDecision בכלל — ממצא ש-snoozed/resolved_by_reply עדיין הופיע כחריג).
 *
 * "snoozed פעיל" ו-"resolved_by_reply" מוחרגים כי escalationDecision.skip כבר מכסה את שניהם —
 * ברגע שה-snooze עובר (או שהממצא לא סומן resolved_by_reply), skip הופך ל-false אוטומטית,
 * בלי צורך בשום פעולה נוספת. לא נוגע ב-Policy/Follow-up/Control Engine — קריאה בלבד.
 */
export function visibleForReports(findings: readonly StoredFinding[], now: DateTime): StoredFinding[] {
  return findings.filter((f) => !escalationDecision(f, now).skip);
}

const SEV_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", normal: "⚪" };

interface BriefingInput {
  now: DateTime;
  decisions: { name: string; detail: string }[];
  projectRisk: StoredFinding[];
  commitmentsAndClients: StoredFinding[];
  criticalTasks: StoredFinding[];
  sales: StoredFinding[];
  collection: StoredFinding[];
  dueToday: { tasks: string[]; payments: string[]; meetings: string[] };
}

/** תדריך בוקר מקוטע לפי מה שדורש תשומת לב ניהולית (CLAUDE.md מטרה 17). */
function briefingText(b: BriefingInput): string {
  const sections: string[] = [];
  const sec = (title: string, all: string[], cap = 10) => {
    if (!all.length) return;
    const shown = all.slice(0, cap);
    if (all.length > cap) shown.push(`  …ועוד ${all.length - cap}`);
    sections.push(`━━ ${title} (${all.length}) ━━\n${shown.join("\n")}`);
  };

  sec(
    "החלטות שמחכות לך",
    b.decisions.map((d) => `  • ${d.name} — ${d.detail}`),
    8,
  );
  sec(
    "פרויקטים בסיכון",
    b.projectRisk.map((f) => `  • ${f.headline}${f.who ? ` (${f.who})` : ""}`),
  );
  sec(
    "התחייבויות ולקוחות שמחכים",
    b.commitmentsAndClients.map((f) => `  ${SEV_ICON[f.severity]} ${f.headline} — ${f.who}`),
  );
  sec(
    "משימות דחופות ותקיעות",
    b.criticalTasks.map((f) => `  ${SEV_ICON[f.severity]} ${f.headline} — ${f.who}`),
  );
  sec(
    "מכירות — פולו-אפ",
    b.sales.map((f) => `  • ${f.headline}${f.who && f.who !== "מוטי" ? ` — ${f.who}` : ""}`),
  );
  sec(
    "גבייה",
    b.collection.map((f) => `  • ${f.headline}`),
  );

  const dueLines: string[] = [];
  if (b.dueToday.meetings.length) dueLines.push(`  פגישות: ${b.dueToday.meetings.join(" · ")}`);
  if (b.dueToday.payments.length) dueLines.push(`  תשלומים: ${b.dueToday.payments.join(" · ")}`);
  if (b.dueToday.tasks.length) dueLines.push(`  משימות: ${b.dueToday.tasks.slice(0, 8).join(" · ")}`);
  if (dueLines.length) sections.push(`━━ מועדים של היום ━━\n${dueLines.join("\n")}`);

  const head = `בוקר טוב מוטי ☀️  (${b.now.toFormat("dd/MM")})`;
  if (sections.length === 0) {
    return `${head}\n\nהבקרה עברה על כל המשרד — אין כרגע שום דבר קריטי או דחוף. יום טוב!`;
  }
  return `${head}\n\n${sections.join("\n\n")}\n\n(הפירוט המלא בחלונית → "בקרה")`;
}

/**
 * נוסח הפנייה היזומה לעובד — קונקרטי, מדבר על המשימה הספציפית, מסתיים בשאלה פתוחה.
 * דוגמה: "דוב, המשימה 'תוכנית חשמל' (פרויקט כהן) — באיחור 3 ימים. מה המצב?"
 */
export function buildNudgeText(
  finding: Pick<StoredFinding, "who" | "headline" | "kind" | "project">,
  ageWord: string,
): string {
  const firstName = finding.who.split(/\s+/)[0] ?? finding.who;
  // ה-headline של ממצא משימה הוא בסגנון "באיחור N ימים: <שם>" — מפרקים לשם + מצב.
  const m = finding.headline.match(/^(.*?):\s*(.+)$/);
  const state = m ? m[1]!.trim() : ageWord;
  const taskName = m ? m[2]!.trim() : finding.headline;
  const NON_PROJECT = new Set(["מכירות", "לידים", "גבייה", "משימת משרד", "פרויקט לא מקושר", ""]);
  const where = finding.project && !NON_PROJECT.has(finding.project) ? ` (פרויקט ${finding.project})` : "";
  const opener =
    finding.kind === "stuck"
      ? `${firstName}, המשימה "${taskName}"${where} מסומנת תקועה`
      : finding.kind === "client_waiting"
        ? `${firstName}, "${taskName}"${where} — ${state}`
        : `${firstName}, המשימה "${taskName}"${where} — ${state}`;
  return `${opener}. מה המצב? אפשר לענות לי כאן בחופשיות (סיימתי / עוד יומיים / מחכה ליועץ / תקוע כי…).`;
}

/**
 * Rule 1 (פנייה ראשונית, audit 2026-09-17): findings ברמת-משימה שכבר עברו תאריך יעד ביום שבו
 * מתגלים לראשונה — לא מחכים ליום עבודה נוסף (ר' targetLevel/businessDaysBetween שלא משתנים).
 * רק overdue_stale/blocking_stale/very_stale, ורק כשיש itemId+itemSource אמיתיים (ר' OVERDUE_TASK_KINDS
 * ולולאת השלב החדש ב-runDailyControlCycle) — stuck/CRM/גבייה/project-level נשארים בחוץ.
 */
const OVERDUE_TASK_KINDS = new Set(["overdue_stale", "blocking_stale", "very_stale"]);

/**
 * ניסוח ניטרלי, לא מסגור-הסלמה (בלי "X ימי עבודה בלי תזוזה") — זו הפנייה הראשונה על המשימה,
 * לא תזכורת חוזרת. דוגמה: "יוכי, המשימה 'הגשת תכניות' (פרויקט X) עברה את מועד היעד. מה המצב איתה?"
 */
export function buildInitialOverdueNudgeText(finding: Pick<StoredFinding, "who" | "headline" | "project">): string {
  const firstName = finding.who.split(/\s+/)[0] ?? finding.who;
  const m = finding.headline.match(/^(.*?):\s*(.+)$/); // אותה פריסה כמו buildNudgeText
  const taskName = m ? m[2]!.trim() : finding.headline;
  const NON_PROJECT = new Set(["מכירות", "לידים", "גבייה", "משימת משרד", "פרויקט לא מקושר", ""]);
  const where = finding.project && !NON_PROJECT.has(finding.project) ? ` (פרויקט ${finding.project})` : "";
  return (
    `${firstName}, המשימה "${taskName}"${where} עברה את מועד היעד. מה המצב איתה? ` +
    `אפשר לענות לי כאן בחופשיות (סיימתי / עוד יומיים / מחכה ליועץ / תקוע כי…).`
  );
}

export interface CycleResult {
  ranAt: string;
  findings: number;
  forManager: number;
  escalations: { level: number; who: string; headline: string }[];
  briefingQueued: boolean;
}

/**
 * Rule 1 (פנייה ראשונית, audit 2026-09-17): findings ברמת-משימה שכבר עברו תאריך יעד ביום הגילוי
 * הראשון — לא מחכים ליום עבודה נוסף. פועלת מעל control_findings שכבר נשמרו (upsertFinding, שלב 1
 * ב-runDailyControlCycle) — לא קוראת ל-Monday בעצמה, לא נוגעת ב-escalationDecision/targetLevel/
 * businessDaysBetween (רק קוראת ל-escalationDecision, לא משנה אותה). מופרדת מ-runDailyControlCycle
 * כדי שאפשר לבדוק אותה בלי scan אמיתי (מקביל ל-escalationDecision).
 *
 * דילוגים (בכוונה, לפי עיצוב מאושר):
 *   - kind לא ב-OVERDUE_TASK_KINDS (stuck/CRM/גבייה/project-level) — לא בסקופ.
 *   - בלי itemId+itemSource — לא ממציאים זהות.
 *   - escalationLevel>0 — כבר טופל (על-ידי הפונקציה הזו או על-ידי ההסלמה הרגילה).
 *   - decision.skip (resolved_by_reply/snoozed) — מכבד סיגנלים קיימים.
 *   - decision.target>0 — המנגנון הקיים כבר יפעל היום (בעיקר critical); לא לשכפל.
 *   - אין assignee מזוהה — לא שולחים, לא מקדמים level (retry-eligible בהרצה הבאה).
 * idempotency ברמת DB (לא רק escalationLevel): hasUnseenNotificationForKind נבדק *לכל משתמש
 * בנפרד* לפני שליחה — קריסה/restart בין addNotification ל-setEscalation לא יכולים ליצור שתי
 * פניות לאותו (user,finding).
 */
export function runInitialOverdueNudgePass(now: DateTime): void {
  const nowIso = now.toISO()!;
  for (const finding of listActiveFindings()) {
    if (!OVERDUE_TASK_KINDS.has(finding.kind)) continue;
    if (!finding.itemId || !finding.itemSource) continue;
    if (finding.escalationLevel > 0) continue;

    const decision = escalationDecision(finding, now);
    if (decision.skip) continue;
    if (decision.target > 0) continue;

    const users = resolveUsersByAssigneeText(finding.who);
    if (users.length === 0) continue;

    const ctx = escalationNotifContext(finding);
    const body = buildInitialOverdueNudgeText(finding);
    let sentToAtLeastOne = false;
    for (const u of users) {
      if (hasUnseenNotificationForKind(u.key, finding.findingKey, "nudge")) {
        sentToAtLeastOne = true;
        continue;
      }
      addNotification(u.key, "nudge", body, finding.findingKey, ctx);
      recordFindingEvent(finding.findingKey, "nudge_sent", { byUser: u.key });
      publishNudge({
        userKey: u.key,
        findingKey: finding.findingKey,
        itemId: finding.itemId,
        itemSource: finding.itemSource,
        body,
        taskName: finding.headline,
        project: finding.project,
        currentDueDateISO: finding.dueDate ?? null,
        createdAt: nowIso,
      });
      try {
        const followupInput: ScheduleNoResponseInput = {
          itemId: finding.itemId,
          itemSource: finding.itemSource as OpsTaskSource,
          findingKey: finding.findingKey,
          userKey: u.key,
          taskName: finding.headline,
          currentDueDateISO: finding.dueDate ?? null,
          missedCommitment: false,
        };
        scheduleInitialNudgeFollowup(followupInput, now);
      } catch (err) {
        logger.error({ err, findingKey: finding.findingKey }, "תזמון initial_nudge_reminder נכשל — הפנייה הראשונית עצמה כבר נשלחה");
      }
      sentToAtLeastOne = true;
    }
    if (sentToAtLeastOne) setEscalation(finding.findingKey, 1, nowIso);
  }
}

export async function runDailyControlCycle(): Promise<CycleResult> {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const nowIso = now.toISO()!;
  logger.info("מנוע הבקרה: מתחיל סבב יומי");

  const [scan, crm] = await Promise.all([runControlScan(), runCrmScan()]);
  const office = await getOfficeState();
  const ownerByProject = new Map(office.projects.map((p) => [p.name, p.owner]));
  const allFindings = [...scan.findings, ...crm.findings];

  // 1. שמירה: כל ממצא נוכחי → upsert
  for (const f of allFindings) {
    upsertFinding({
      findingKey: f.key,
      kind: f.kind,
      severity: f.severity,
      who: f.who,
      project: f.project,
      headline: f.headline,
      detail: f.detail,
      url: f.url,
      itemId: "itemId" in f ? (f as { itemId?: string }).itemId : undefined,
      itemSource: "itemSource" in f ? (f as { itemSource?: string }).itemSource : undefined,
      dueDate: "dueDate" in f ? (f as { dueDate?: string }).dueDate : undefined,
      now: nowIso,
    });
  }
  // 2. כל מה שלא נראה בסריקה הזו → נפתר
  resolveStaleFindings(nowIso, nowIso);

  // 2.5 פנייה ראשונית מיידית (Rule 1) — מופרדת לפונקציה משלה כדי שאפשר לבדוק את הלוגיקה בלי
  // סריקה אמיתית (אותו טעם כמו escalationDecision למעלה).
  runInitialOverdueNudgePass(now);

  // 3. הסלמה
  const escalations: CycleResult["escalations"] = [];
  for (const finding of listActiveFindings()) {
    const decision = escalationDecision(finding, now);
    if (decision.skip) continue; // העובד סגר / נדחה — הבקרה שקטה
    const { target, stale } = decision;
    if (target <= finding.escalationLevel) continue;

    const ageWord =
      finding.severity === "critical" && stale < 1
        ? "מסומן קריטי"
        : `${stale} ימי עבודה בלי תזוזה`;

    for (let level = finding.escalationLevel + 1; level <= target; level++) {
      if (level === 1) {
        const nudgeBody = buildNudgeText(finding, ageWord);
        for (const u of resolveUsersByAssigneeText(finding.who)) {
          addNotification(u.key, "nudge", nudgeBody, finding.findingKey, {
            itemId: finding.itemId ?? undefined,
            itemSource: finding.itemSource ?? undefined,
            context: {
              taskName: finding.headline,
              project: finding.project ?? undefined,
              // תאריך היעד הידוע מרגע הסריקה — כדי ש-Policy Engine (replyDefer) לא יצטרך לנחש
              // או לקרוא שוב ל-Monday כשהעובד יענה על הפנייה. ראה LoopContext.currentDueDateISO.
              currentDueDateISO: finding.dueDate ?? null,
            },
          });
          recordFindingEvent(finding.findingKey, "nudge_sent", { byUser: u.key });
          publishNudge({
            userKey: u.key,
            findingKey: finding.findingKey,
            itemId: finding.itemId,
            itemSource: finding.itemSource,
            body: nudgeBody,
            taskName: finding.headline,
            project: finding.project,
            currentDueDateISO: finding.dueDate ?? null,
            createdAt: nowIso,
          });
        }
      } else if (level === 2) {
        const owner = finding.project ? ownerByProject.get(finding.project) : undefined;
        for (const pm of resolveUsersByAssigneeText(owner ?? "")) {
          if (pm.name === finding.who) continue; // מנהל הפרויקט הוא גם האחראי — כבר קיבל תזכורת
          addNotification(
            pm.key,
            "escalation",
            `הסלמה בפרויקט שלך (${finding.project}):\n"${finding.headline}" — ${ageWord}. אחראי: ${finding.who}.`,
            finding.findingKey,
            escalationNotifContext(finding),
          );
        }
      } else if (level === 3) {
        const moti = resolveUserByKey("moti");
        if (moti) {
          addNotification(
            moti.key,
            "escalation",
            `⚠️ ${ageWord}: "${finding.headline}" (${finding.who}).\n${finding.detail}`,
            finding.findingKey,
            escalationNotifContext(finding),
          );
        }
      }
      escalations.push({ level, who: finding.who, headline: finding.headline });
    }
    setEscalation(finding.findingKey, target, nowIso);
  }

  // 4. תדריך בוקר למוטי — מקוטע לפי מה שדורש תשומת לב ניהולית, כל יום
  // visibleForReports (audit 2026-09-17): לא מציג ממצא ש-snoozed פעיל / resolved_by_reply —
  // הבקרה כבר "הסכימה לשתוק" עליו, אין טעם להטריד את מוטי בו כחריג.
  const managerFindings = visibleForReports(listActiveFindings(), now)
    .filter((f) => f.severity !== "normal")
    .sort((a, b) => (a.severity === "critical" ? -1 : 0) - (b.severity === "critical" ? -1 : 0));

  const CRM_AREAS = new Set(["מכירות", "לידים", "גבייה"]);
  const isProjectRisk = (f: StoredFinding) => f.kind === "project_stuck" || f.kind === "delivery_overdue";
  const isCommitmentOrClient = (f: StoredFinding) =>
    f.kind === "commitment_overdue" || f.kind === "client_waiting";

  const dayStart = now.startOf("day");
  const dayEnd = now.endOf("day");
  // היומן הוא "נחמד שיש" בתדריך — לא מפיל ולא מעכב את הסבב אם Google לא זמין/לא מוגדר.
  const calendarTimeout = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 15_000));
  const meetings = await Promise.race([
    listCalendarEvents({ timeMinISO: dayStart.toISO()!, timeMaxISO: dayEnd.toISO()! })
      .then((evs) => evs.map((e) => `${e.summary ?? "פגישה"}${e.start ? ` (${e.start})` : ""}`))
      .catch(() => [] as string[]),
    calendarTimeout,
  ]);

  const dueTodayTasks = [
    ...new Map(
      office.allTasks
        .filter((t) => t.flags.dueToday)
        .map((t) => [t.itemId, `${t.name}${t.assignees ? ` (${t.assignees})` : ""}`]),
    ).values(),
  ];

  const text = briefingText({
    now,
    decisions: crm.decisions,
    projectRisk: managerFindings.filter(isProjectRisk),
    commitmentsAndClients: managerFindings.filter(isCommitmentOrClient),
    criticalTasks: managerFindings.filter(
      (f) => !CRM_AREAS.has(f.project ?? "") && !isProjectRisk(f) && !isCommitmentOrClient(f),
    ),
    sales: managerFindings.filter((f) => f.project === "מכירות" || f.project === "לידים"),
    collection: managerFindings.filter((f) => f.project === "גבייה"),
    dueToday: {
      tasks: dueTodayTasks,
      payments: crm.paymentsDueToday.map((p) => `${p.label}${p.amount ? ` ${p.amount}` : ""}`),
      meetings,
    },
  });

  const moti = resolveUserByKey("moti");
  let briefingQueued = false;
  if (moti) {
    supersedeKind(moti.key, "briefing"); // תדריך היום מחליף את של אתמול
    addNotification(moti.key, "briefing", text);
    if (moti.whatsappJid) {
      enqueueWhatsapp(moti.whatsappJid, text, true);
      briefingQueued = true;
    }
  }

  logger.info(
    { findings: allFindings.length, escalations: escalations.length, briefingQueued },
    "מנוע הבקרה: סבב הסתיים",
  );

  return {
    ranAt: nowIso,
    findings: allFindings.length,
    forManager: managerFindings.length,
    escalations,
    briefingQueued,
  };
}
