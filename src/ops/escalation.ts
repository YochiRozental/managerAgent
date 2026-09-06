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
import { addNotification, supersedeKind } from "../db/repositories/notifications.js";
import { enqueueWhatsapp } from "../db/repositories/whatsappOutbox.js";
import { resolveUserByKey, resolveUsersByAssigneeText } from "../identity/index.js";
import { listCalendarEvents } from "../integrations/google/calendar.js";
import { logger } from "../utils/logger.js";
import { runControlScan, type Severity } from "./controlScan.js";
import { runCrmScan } from "./crmScan.js";
import { getOfficeState } from "./officeState.js";

/** ימי עבודה (א׳–ה׳) בין שני תאריכים, לא כולל היום הראשון. */
function businessDaysBetween(from: DateTime, to: DateTime): number {
  let count = 0;
  let d = from.startOf("day").plus({ days: 1 });
  const end = to.startOf("day");
  while (d <= end) {
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

const SEV_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", normal: "⚪" };

interface BriefingInput {
  now: DateTime;
  decisions: { name: string; detail: string }[];
  projectRisk: StoredFinding[];
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

export interface CycleResult {
  ranAt: string;
  findings: number;
  forManager: number;
  escalations: { level: number; who: string; headline: string }[];
  briefingQueued: boolean;
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
      now: nowIso,
    });
  }
  // 2. כל מה שלא נראה בסריקה הזו → נפתר
  resolveStaleFindings(nowIso, nowIso);

  // 3. הסלמה
  const escalations: CycleResult["escalations"] = [];
  for (const finding of listActiveFindings()) {
    const stale = businessDaysBetween(DateTime.fromISO(finding.firstSeen), now);
    const target = targetLevel(finding.severity, stale);
    if (target <= finding.escalationLevel) continue;

    const ageWord =
      finding.severity === "critical" && stale < 1
        ? "מסומן קריטי"
        : `${stale} ימי עבודה בלי תזוזה`;

    for (let level = finding.escalationLevel + 1; level <= target; level++) {
      if (level === 1) {
        for (const u of resolveUsersByAssigneeText(finding.who)) {
          addNotification(
            u.key,
            "reminder",
            `תזכורת מהבקרה על משימה שלך (${ageWord}):\n"${finding.headline}"\n${finding.detail}\nמה קורה עם זה? אפשר לעדכן אותי כאן.`,
            finding.findingKey,
          );
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
          );
        }
      }
      escalations.push({ level, who: finding.who, headline: finding.headline });
    }
    setEscalation(finding.findingKey, target, nowIso);
  }

  // 4. תדריך בוקר למוטי — מקוטע לפי מה שדורש תשומת לב ניהולית, כל יום
  const managerFindings = listActiveFindings()
    .filter((f) => f.severity !== "normal")
    .sort((a, b) => (a.severity === "critical" ? -1 : 0) - (b.severity === "critical" ? -1 : 0));

  const CRM_AREAS = new Set(["מכירות", "לידים", "גבייה"]);
  const isProjectRisk = (f: StoredFinding) => f.kind === "project_stuck" || f.kind === "delivery_overdue";

  const dayStart = now.startOf("day");
  const dayEnd = now.endOf("day");
  const meetings = await listCalendarEvents({ timeMinISO: dayStart.toISO()!, timeMaxISO: dayEnd.toISO()! })
    .then((evs) => evs.map((e) => `${e.summary ?? "פגישה"}${e.start ? ` (${e.start})` : ""}`))
    .catch(() => [] as string[]);

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
    criticalTasks: managerFindings.filter((f) => !CRM_AREAS.has(f.project ?? "") && !isProjectRisk(f)),
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
      enqueueWhatsapp(moti.whatsappJid, text);
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
