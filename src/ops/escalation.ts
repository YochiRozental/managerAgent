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
} from "../db/repositories/controlFindings.js";
import { addNotification, supersedeKind } from "../db/repositories/notifications.js";
import { enqueueWhatsapp } from "../db/repositories/whatsappOutbox.js";
import { resolveUserByKey, resolveUsersByAssigneeText } from "../identity/index.js";
import { logger } from "../utils/logger.js";
import { runControlScan, type Severity } from "./controlScan.js";
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

const SEV_LABEL: Record<Severity, string> = { critical: "🔴 קריטי", high: "🟠 דחוף", normal: "⚪" };

function briefingText(
  findings: { severity: Severity; headline: string; detail: string; who: string }[],
  now: DateTime,
): string {
  if (findings.length === 0) {
    return `בוקר טוב מוטי ☀️\n\nהבקרה עברה על כל המשרד — אין כרגע שום דבר קריטי או דחוף. יום טוב!`;
  }
  const lines = [
    `בוקר טוב מוטי ☀️  (${now.toFormat("dd/MM")})`,
    ``,
    `הבקרה מצאה ${findings.length} דברים שדורשים תשומת לב:`,
  ];
  const byWho = new Map<string, typeof findings>();
  for (const f of findings) {
    const arr = byWho.get(f.who) ?? [];
    arr.push(f);
    byWho.set(f.who, arr);
  }
  for (const [who, list] of byWho) {
    lines.push(``, `▸ ${who}`);
    for (const f of list) lines.push(`   ${SEV_LABEL[f.severity]} ${f.headline}`);
  }
  lines.push(``, `(הפירוט המלא בחלונית → "בקרה")`);
  return lines.join("\n");
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

  const scan = await runControlScan();
  const { projects } = await getOfficeState();
  const ownerByProject = new Map(projects.map((p) => [p.name, p.owner]));

  // 1. שמירה: כל ממצא נוכחי → upsert
  for (const f of scan.findings) {
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

  // 4. תדריך בוקר למוטי — כל ה-critical+high הפעילים, כל יום
  const managerFindings = listActiveFindings()
    .filter((f) => f.severity !== "normal")
    .sort((a, b) => (a.severity === "critical" ? -1 : 0) - (b.severity === "critical" ? -1 : 0));
  const text = briefingText(managerFindings, now);

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
    { findings: scan.findings.length, escalations: escalations.length, briefingQueued },
    "מנוע הבקרה: סבב הסתיים",
  );

  return {
    ranAt: nowIso,
    findings: scan.findings.length,
    forManager: managerFindings.length,
    escalations,
    briefingQueued,
  };
}
