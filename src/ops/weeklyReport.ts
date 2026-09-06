/**
 * דוח שבועי למוטי (שלב 4, מטרה 18) — רטרוספקטיבה + מבט קדימה.
 *
 * שונה מתדריך הבוקר (מה דורש תשומת לב עכשיו): הדוח השבועי מסתכל אחורה — מה זז השבוע, מה לא —
 * ומה צפוי בשבוע הבא. הסיגנל ההיסטורי המרכזי הוא טבלת control_findings (מתי כל ממצא נפתח/נסגר).
 *
 * רץ ראשון בשבוע (א׳) ב-08:00. נשלח כ-notification למוטי + לתור ה-WhatsApp.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { listOpenCommitments } from "../db/repositories/commitments.js";
import {
  chronicFindings,
  findingsOpenedSince,
  findingsResolvedSince,
} from "../db/repositories/controlFindings.js";
import { addNotification, supersedeKind } from "../db/repositories/notifications.js";
import { enqueueWhatsapp } from "../db/repositories/whatsappOutbox.js";
import { resolveUserByKey } from "../identity/index.js";
import { fetchSigningsSince } from "../integrations/monday/crmRead.js";
import { logger } from "../utils/logger.js";
import { runControlScan } from "./controlScan.js";
import { runCrmScan } from "./crmScan.js";
import { getOfficeState } from "./officeState.js";
import { getOversightReport } from "./oversight.js";

export interface WeeklyReport {
  generatedAt: string;
  since: string;
  text: string;
}

function ils(n: number): string {
  return `${Math.round(n).toLocaleString("he-IL")} ₪`;
}
function topN<T>(rec: Record<string, number>, n: number): [string, number][] {
  return Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

export async function buildWeeklyReport(): Promise<WeeklyReport> {
  const now = DateTime.now().setZone(env.TIMEZONE);
  const weekAgo = now.minus({ days: 7 });
  const weekAgoIso = weekAgo.toISO()!;
  const nextWeekEnd = now.plus({ days: 7 }).startOf("day");

  logger.info("דוח שבועי: מתחיל");

  const moti = resolveUserByKey("moti");
  const [office, ctrl, crm, over, signings] = await Promise.all([
    getOfficeState(),
    runControlScan(),
    runCrmScan(),
    moti ? getOversightReport(moti) : Promise.resolve(null),
    fetchSigningsSince(weekAgoIso).catch(() => []),
  ]);

  const opened = findingsOpenedSince(weekAgoIso);
  const resolved = findingsResolvedSince(weekAgoIso);
  const chronic = chronicFindings(weekAgoIso);

  const s: string[] = [`📊 דוח שבועי — ${weekAgo.toFormat("dd/MM")} עד ${now.toFormat("dd/MM/yyyy")}`, ""];

  // ---- הבקרה השבוע ----
  const net = opened.length - resolved.length;
  s.push("━━ הבקרה השבוע ━━");
  s.push(`  נפתחו ${opened.length} ממצאים · נסגרו ${resolved.length} · שינוי נטו ${net >= 0 ? "+" : ""}${net}`);
  if (chronic.length) {
    s.push(`  ${chronic.length} ממצאים פתוחים מעל שבוע — הכי ותיקים:`);
    for (const f of chronic.slice(0, 6)) {
      const age = Math.floor(now.diff(DateTime.fromISO(f.firstSeen), "days").days);
      s.push(`    • ${f.headline} (${age} ימים · ${f.who})`);
    }
  }
  s.push("");

  // ---- מצב הצוות ----
  if (over) {
    s.push("━━ מצב הצוות (עכשיו) ━━");
    for (const p of over.people) {
      if (p.counts.open === 0) continue;
      s.push(
        `  ${p.name}: ${p.counts.open} פתוחות · ${p.counts.overdue} באיחור · ${p.counts.stuck} תקועות · ${p.counts.blocking} חוסמות`,
      );
    }
    s.push("");
  }

  // ---- פרויקטים ----
  const risky = ctrl.findings.filter((f) => f.kind === "project_stuck" || f.kind === "delivery_overdue");
  const deliveriesSoon = office.projects.filter((p) => {
    if (!p.deliveryDate) return false;
    const d = DateTime.fromISO(p.deliveryDate, { zone: env.TIMEZONE }).startOf("day");
    return d >= now.startOf("day") && d <= nextWeekEnd;
  });
  s.push("━━ פרויקטים ━━");
  s.push(`  ${office.projects.length} פרויקטים פעילים · ${risky.length} בסיכון (תקוע / איחור מסירה)`);
  for (const f of risky.slice(0, 8)) s.push(`    • ${f.headline} (${f.who})`);
  if (deliveriesSoon.length) {
    s.push(`  מסירות מתוכננות בשבוע הקרוב: ${deliveriesSoon.map((p) => `${p.name} (${p.deliveryDate})`).join(" · ")}`);
  }
  s.push("");

  // ---- מכירות ----
  s.push("━━ מכירות ━━");
  s.push(`  ${crm.pipeline.openDeals} עסקאות פתוחות · ${crm.pipeline.openLeads} לידים פתוחים`);
  const signedSum = signings.reduce((a, x) => a + (Number(x.amount.replace(/[^\d.-]/g, "")) || 0), 0);
  if (signings.length) {
    s.push(`  ✍️ נחתמו השבוע: ${signings.length}${signedSum ? ` (${ils(signedSum)})` : ""} — ${signings.map((x) => x.name).join(", ")}`);
  } else {
    s.push("  ✍️ נחתמו השבוע: 0");
  }
  s.push(`  לידים חדשים ב-14 הימים האחרונים: ${crm.pipeline.leadsCreatedRecent.length}`);
  const stageTop = topN(crm.pipeline.dealsByStage, 5);
  if (stageTop.length) s.push(`  פיזור עסקאות: ${stageTop.map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  const salesFindings = crm.findings.filter((f) => f.project === "מכירות" || f.project === "לידים");
  s.push(`  דורש טיפול: ${salesFindings.length} (פולו-אפים, הצעות תלויות)`);
  s.push("");

  // ---- התחייבויות ----
  const commitments = listOpenCommitments();
  if (commitments.length) {
    const overdue = commitments.filter((c) => c.dueDate && c.dueDate < now.toISODate()!);
    const soon = commitments.filter((c) => {
      if (!c.dueDate) return false;
      const d = DateTime.fromISO(c.dueDate, { zone: env.TIMEZONE }).startOf("day");
      return d >= now.startOf("day") && d <= nextWeekEnd;
    });
    s.push("━━ התחייבויות ללקוחות ━━");
    s.push(`  ${commitments.length} פתוחות · ${overdue.length} באיחור · ${soon.length} לשבוע הקרוב`);
    for (const c of [...overdue, ...soon].slice(0, 6)) {
      s.push(`    • ${c.toWhom}: ${c.what}${c.dueDate ? ` (${c.dueDate})` : ""}`);
    }
    s.push("");
  }

  // ---- גבייה ----
  const payFindings = crm.findings.filter((f) => f.project === "גבייה");
  s.push("━━ גבייה ━━");
  s.push(`  ${payFindings.length} ממצאים פתוחים (תשלומים באיחור / גבייה מאחרת)`);
  if (crm.paymentsDueSoon.length) {
    const soonSum = crm.paymentsDueSoon.reduce((a, p) => a + (Number(p.amount.replace(/[^\d.-]/g, "")) || 0), 0);
    s.push(`  צפויים להיכנס בשבוע הקרוב: ${crm.paymentsDueSoon.length} תשלומים${soonSum ? ` (~${ils(soonSum)})` : ""}`);
  }
  s.push("");

  // ---- צפי לשבוע הבא ----
  const tasksNextWeek = office.allTasks.filter((t) => {
    if (!t.dueDate) return false;
    const d = DateTime.fromISO(t.dueDate, { zone: env.TIMEZONE }).startOf("day");
    return d >= now.startOf("day") && d <= nextWeekEnd;
  });
  s.push("━━ צפי לשבוע הבא ━━");
  s.push(`  ${tasksNextWeek.length} משימות עם תאריך יעד בשבוע הקרוב`);
  if (crm.remindersDueSoon.length) {
    s.push(`  ${crm.remindersDueSoon.length} תזכורות מכירות (לידים/עסקאות) לשבוע הקרוב`);
  }
  s.push("");
  s.push('(הפירוט המלא בחלונית → "בקרה")');

  const text = s.join("\n");

  if (moti) {
    supersedeKind(moti.key, "weekly");
    addNotification(moti.key, "weekly", text);
    if (moti.whatsappJid) enqueueWhatsapp(moti.whatsappJid, text, true);
  }

  logger.info(
    { opened: opened.length, resolved: resolved.length, chronic: chronic.length, signings: signings.length },
    "דוח שבועי: הסתיים",
  );
  return { generatedAt: now.toISO() ?? "", since: weekAgoIso, text };
}
