/**
 * בקרת CRM (שלב 4, הרחבה): לידים · עסקאות (פייפליין המכירות) · גבייה.
 *
 * אותה תבנית של controlScan — ממצאים מסווגים לפי חומרה, כל אחד עם `who` להסלמה. הסיגנל המרכזי
 * בשלושת הבורדים הוא "תאריך הבא לתזכורת" שעבר בלי שקרה כלום.
 *
 * ניתוב אחריות: לידים ועסקאות → האחראי, ואם ריק → מוטי (מנהל המכירות). גבייה → גולדי (סעיף 3).
 * ספי הימים v1 — לכיוונון.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import {
  fetchOpenCollections,
  fetchOpenDeals,
  fetchOpenLeads,
} from "../integrations/monday/crmRead.js";
import type { Finding } from "./controlScan.js";

export interface CrmScanReport {
  generatedAt: string;
  counts: { critical: number; high: number; normal: number; total: number };
  findings: Finding[];
  forManager: Finding[];
  /** עסקאות/הצעות בשלב שדורש החלטה או תגובה של מוטי — לתדריך הבוקר */
  decisions: { name: string; detail: string; url: string }[];
  /** תשלומים שאמורים להיכנס היום */
  paymentsDueToday: { label: string; amount: string; url: string }[];
  /** נתוני פייפליין — לדוח השבועי */
  pipeline: {
    openLeads: number;
    leadsByStatus: Record<string, number>;
    openDeals: number;
    dealsByStage: Record<string, number>;
    leadsCreatedRecent: { name: string; date: string }[];
  };
  /** תשלומים / תזכורות שאמורים ב-10 הימים הקרובים — לצפי השבוע הבא */
  paymentsDueSoon: { label: string; amount: string; date: string }[];
  remindersDueSoon: { name: string; kind: string; date: string }[];
}

let cache: { at: number; report: CrmScanReport } | null = null;
const TTL_MS = 5 * 60_000;

const SEV_ORDER = { critical: 0, high: 1, normal: 2 } as const;
const LEAD_ACTIVE = new Set(["ליד חדש", "פוטנציאלי", "ניסיון יצירת קשר"]);
// לידים שכבר "עברו הלאה" — מטופלים בבורד העסקאות / מוקפאים במכוון, אין טעם ברדיפה על בורד הלידים
const LEAD_MOVED_ON = new Set(["עבר לעסקה", "הוקפא"]);
const PROPOSAL_STAGES = new Set(["נשלחה הצעת מחיר", "ממתין להצעת מחיר"]);
const DECISION_STAGES = new Set(["משא ומתן", "בדרך לסגירה", "נשלחה הצעת מחיר", "ממתין להצעת מחיר"]);
const PAYMENT_TODO = new Set(["לגבייה", "תשלום חדש", "נשלחה דרישת תשלום"]);

function ils(amount: string): string {
  const n = Number(amount.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? `${n.toLocaleString("he-IL")} ₪` : "";
}

export async function runCrmScan(force = false): Promise<CrmScanReport> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.report;

  const now = DateTime.now().setZone(env.TIMEZONE);
  const today = now.startOf("day");
  const daysPast = (d?: string) =>
    d ? Math.floor(today.diff(DateTime.fromISO(d, { zone: env.TIMEZONE }).startOf("day"), "days").days) : -1;

  const [leads, deals, collections] = await Promise.all([
    fetchOpenLeads().catch(() => []),
    fetchOpenDeals().catch(() => []),
    fetchOpenCollections().catch(() => []),
  ]);

  const findings: Finding[] = [];
  const decisions: CrmScanReport["decisions"] = [];
  const paymentsDueToday: CrmScanReport["paymentsDueToday"] = [];
  const paymentsDueSoon: CrmScanReport["paymentsDueSoon"] = [];
  const remindersDueSoon: CrmScanReport["remindersDueSoon"] = [];
  const soonEnd = today.plus({ days: 10 });
  const inSoon = (d?: string) => {
    if (!d) return false;
    const dt = DateTime.fromISO(d, { zone: env.TIMEZONE }).startOf("day");
    return dt >= today && dt <= soonEnd;
  };
  const recentStart = today.minus({ days: 14 }).toISODate()!;

  const leadsByStatus: Record<string, number> = {};
  const dealsByStage: Record<string, number> = {};
  const leadsCreatedRecent: { name: string; date: string }[] = [];

  // ---- לידים ----
  for (const l of leads) {
    leadsByStatus[l.status] = (leadsByStatus[l.status] ?? 0) + 1;
    if (l.createdDate && l.createdDate >= recentStart) leadsCreatedRecent.push({ name: l.name, date: l.createdDate });
    if (LEAD_MOVED_ON.has(l.status)) continue;
    if (inSoon(l.reminderDate)) remindersDueSoon.push({ name: l.name, kind: "ליד", date: l.reminderDate! });
    const who = l.owner || "מוטי";
    const over = daysPast(l.reminderDate);
    if (over > 0) {
      findings.push({
        key: `lead_fu:${l.itemId}`,
        severity: over >= 3 ? "high" : "normal",
        kind: "overdue_stale",
        headline: `ליד — פולו-אפ באיחור ${over} ימים: ${l.name}`,
        detail: `סטטוס "${l.status}"${l.source ? ` · מקור: ${l.source}` : ""}`,
        who,
        project: "לידים",
        url: l.url,
      });
    } else if (!l.reminderDate && LEAD_ACTIVE.has(l.status)) {
      findings.push({
        key: `lead_nonext:${l.itemId}`,
        severity: "normal",
        kind: "overdue_stale",
        headline: `ליד בלי פעולה הבאה: ${l.name}`,
        detail: `סטטוס "${l.status}" — אין תאריך לתזכורת`,
        who,
        project: "לידים",
        url: l.url,
      });
    }
    if (l.status === "ליד חדש" && daysPast(l.createdDate) >= 5) {
      findings.push({
        key: `lead_new:${l.itemId}`,
        severity: "high",
        kind: "overdue_stale",
        headline: `ליד חדש שלא נלקח (${daysPast(l.createdDate)} ימים): ${l.name}`,
        detail: `עדיין "ליד חדש"${l.source ? ` · מקור: ${l.source}` : ""}`,
        who,
        project: "לידים",
        url: l.url,
      });
    }
    if (!l.owner) {
      findings.push({
        key: `lead_noowner:${l.itemId}`,
        severity: "normal",
        kind: "no_owner",
        headline: `ליד בלי אחראי: ${l.name}`,
        detail: `סטטוס "${l.status}"`,
        who: "מוטי",
        project: "לידים",
        url: l.url,
      });
    }
  }

  // ---- עסקאות / הצעות מחיר ----
  for (const d of deals) {
    dealsByStage[d.stage] = (dealsByStage[d.stage] ?? 0) + 1;
    if (inSoon(d.reminderDate)) remindersDueSoon.push({ name: d.name, kind: "עסקה", date: d.reminderDate! });
    const who = d.owner || "מוטי";
    const over = daysPast(d.reminderDate);
    const hot = d.closeChance === "ליד חם" || d.closeChance === "פושר";

    if (DECISION_STAGES.has(d.stage)) {
      decisions.push({
        name: d.name,
        detail: `שלב "${d.stage}"${d.closeChance ? ` · סיכוי: ${d.closeChance}` : ""}${
          d.expectedClose ? ` · סגירה צפויה ${d.expectedClose}` : ""
        }`,
        url: d.url,
      });
    }

    if (PROPOSAL_STAGES.has(d.stage) && (over > 0 || !d.reminderDate)) {
      findings.push({
        key: `deal_prop:${d.itemId}`,
        severity: "high",
        kind: "overdue_stale",
        headline: `הצעת מחיר בלי פולו-אפ: ${d.name}`,
        detail: `שלב "${d.stage}"${over > 0 ? ` · תזכורת עברה לפני ${over} ימים` : " · אין תאריך לתזכורת"}${
          d.closeChance ? ` · סיכוי: ${d.closeChance}` : ""
        }`,
        who,
        project: "מכירות",
        url: d.url,
      });
    } else if (over > 0) {
      findings.push({
        key: `deal_fu:${d.itemId}`,
        severity: hot || over >= 4 ? "high" : "normal",
        kind: "overdue_stale",
        headline: `עסקה — פולו-אפ באיחור ${over} ימים: ${d.name}`,
        detail: `שלב "${d.stage}"${d.closeChance ? ` · סיכוי: ${d.closeChance}` : ""}`,
        who,
        project: "מכירות",
        url: d.url,
      });
    }
    if (!d.owner) {
      findings.push({
        key: `deal_noowner:${d.itemId}`,
        severity: "normal",
        kind: "no_owner",
        headline: `עסקה בלי אחראי: ${d.name}`,
        detail: `שלב "${d.stage}"`,
        who: "מוטי",
        project: "מכירות",
        url: d.url,
      });
    }
  }

  // ---- גבייה ----
  for (const c of collections) {
    const label = `${c.name}${c.project ? ` (${c.project})` : ""}`;
    if (c.status === "מאחר") {
      findings.push({
        key: `coll_late:${c.itemId}`,
        severity: "high",
        kind: "overdue_stale",
        headline: `גבייה מאחרת: ${label}`,
        detail: `${c.remaining ? `נותר לגבות: ${ils(c.remaining)} · ` : ""}אחראי פרויקט: ${c.projectOwner || "—"}`,
        who: "גולדי",
        project: "גבייה",
        url: c.url,
      });
    }
    for (const p of c.payments) {
      const over = daysPast(p.dueDate);
      if (over === 0) {
        paymentsDueToday.push({ label, amount: ils(p.amount) || p.amount, url: c.url });
      }
      if (p.dueDate && over < 0 && inSoon(p.dueDate)) {
        paymentsDueSoon.push({ label, amount: ils(p.amount) || p.amount, date: p.dueDate });
      }
      if (over > 0) {
        findings.push({
          key: `pay_over:${p.itemId}`,
          severity: over > 30 ? "critical" : "high",
          kind: "overdue_stale",
          headline: `תשלום באיחור ${over} ימים${ils(p.amount) ? ` (${ils(p.amount)})` : ""}: ${label}`,
          detail: `${p.name} · תאריך לתשלום ${p.dueDate} · סטטוס "${p.status || "לא הוגדר"}"`,
          who: "גולדי",
          project: "גבייה",
          url: c.url,
        });
      } else if (!p.dueDate && PAYMENT_TODO.has(p.status)) {
        findings.push({
          key: `pay_nodate:${p.itemId}`,
          severity: "normal",
          kind: "no_owner",
          headline: `תשלום בלי תאריך: ${label}`,
          detail: `${p.name}${ils(p.amount) ? ` · ${ils(p.amount)}` : ""} · סטטוס "${p.status}"`,
          who: "גולדי",
          project: "גבייה",
          url: c.url,
        });
      }
    }
  }

  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const counts = { critical: 0, high: 0, normal: 0, total: findings.length };
  for (const f of findings) counts[f.severity]++;

  const report: CrmScanReport = {
    generatedAt: now.toISO() ?? "",
    counts,
    findings,
    forManager: findings.filter((f) => f.severity !== "normal"),
    decisions,
    paymentsDueToday,
    pipeline: {
      openLeads: leads.filter((l) => !LEAD_MOVED_ON.has(l.status)).length,
      leadsByStatus,
      openDeals: deals.length,
      dealsByStage,
      leadsCreatedRecent,
    },
    paymentsDueSoon,
    remindersDueSoon,
  };
  cache = { at: Date.now(), report };
  return report;
}
