/**
 * מנוע הבקרה (שלב 4) — סריקה יזומה של כל המשרד שמוציאה רק חריגים.
 *
 * במקום שמישהו יחפש מה תקוע — הסוכן סורק ומחזיר רשימת "ממצאים" מסווגים לפי חומרה, כל אחד עם
 * מי אחראי לו (לצורך הסלמה בהמשך). מחושב מעל getOfficeState — לא מוסיף קריאות ל-Monday.
 *
 * ההגדרות והספים כאן v1 — לכיוונון מול מוטי אחרי הרצה (CLAUDE.md סעיף 7).
 */

import { listOpenCommitments } from "../db/repositories/commitments.js";
import { resolveUserByKey, userCan, type IdentifiedUser } from "../identity/index.js";
import type { DashboardTask } from "./dashboard.js";
import { getOfficeState } from "./officeState.js";
import { DateTime } from "luxon";
import { env } from "../config/env.js";

export type Severity = "critical" | "high" | "normal";

export interface Finding {
  /** מפתח יציב לזיהוי/דה-דופ בין סריקות */
  key: string;
  severity: Severity;
  kind:
    | "stuck"
    | "blocking_stale"
    | "overdue_stale"
    | "very_stale"
    | "no_owner"
    | "delivery_overdue"
    | "project_stuck"
    | "stage_gap"
    | "commitment_overdue"
    | "client_waiting";
  headline: string;
  detail: string;
  /** מי אמור לטפל — לצורך ההסלמה */
  who: string;
  project?: string;
  url?: string;
}

export interface ControlScanReport {
  generatedAt: string;
  counts: { critical: number; high: number; normal: number; total: number };
  findings: Finding[];
  /** מה שדורש תשומת לב ניהולית — critical + high בלבד (זה מה שמוטי מקבל) */
  forManager: Finding[];
  byPerson: { who: string; count: number }[];
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, normal: 2 };
const VERY_STALE_DAYS = 45; // מעבר לזה — כנראה דאטה ישן שצריך ניקוי, לא סיגנל תפעולי חי

function ownerOf(task: DashboardTask, projectOwner: string | undefined): string {
  return task.assignees || projectOwner || "מנהל/ת המשרד";
}

export async function runControlScan(): Promise<ControlScanReport> {
  const { generatedAt, allTasks, projects, now } = await getOfficeState();
  const today = now.startOf("day");
  const projectOwnerByName = new Map(projects.map((p) => [p.name, p.owner]));
  const openTeamTasksByProject = new Map<string, number>();
  for (const t of allTasks) {
    if (t.source === "project_stage") {
      openTeamTasksByProject.set(t.context, (openTeamTasksByProject.get(t.context) ?? 0) + 1);
    }
  }

  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // ---- ממצאים ברמת המשימה ----
  for (const t of allTasks) {
    const who = ownerOf(t, projectOwnerByName.get(t.context));
    const where = t.stageName ? `${t.context} › ${t.stageName}` : t.context;
    const f = t.flags;

    if (f.stuck) {
      const blocks = f.blocking.length;
      add({
        key: `stuck:${t.itemId}`,
        severity: blocks > 0 ? "critical" : "high",
        kind: "stuck",
        headline: `תקוע: ${t.name}`,
        detail: `${where}${blocks ? ` — וחוסם ${blocks} משימות אחרות` : ""}${
          t.dueDate ? ` · תאריך יעד ${t.dueDate}` : ""
        }`,
        who,
        project: t.context,
        url: t.url,
      });
      continue; // תקוע מכסה גם את האיחור
    }

    // "חוסם אחרים" לבד אינו סיגנל — במאגר המשימות כמעט כל משימה תלויה בקודמת. רק אם היא גם באיחור.
    if (f.blocking.length > 0 && f.overdue && !f.waitingExternal) {
      add({
        key: `blocking:${t.itemId}`,
        severity: f.blocking.length >= 2 ? "critical" : "high",
        kind: "blocking_stale",
        headline: `באיחור ${f.daysOverdue} ימים וחוסם ${f.blocking.length}: ${t.name}`,
        detail: `${where} · חוסם: ${f.blocking
          .slice(0, 3)
          .map((d) => d.name)
          .join(", ")}`,
        who,
        project: t.context,
        url: t.url,
      });
      continue;
    }

    if (f.overdue && !f.waitingExternal && t.status !== "בעבודה") {
      if (f.daysOverdue > VERY_STALE_DAYS) {
        add({
          key: `verystale:${t.itemId}`,
          severity: "normal",
          kind: "very_stale",
          headline: `ישן מאוד (${f.daysOverdue} ימים): ${t.name}`,
          detail: `${where} — כנראה צריך לסגור/לעדכן תאריך ב-Monday`,
          who,
          project: t.context,
          url: t.url,
        });
      } else {
        add({
          key: `overdue:${t.itemId}`,
          severity: f.daysOverdue >= 7 || f.critical ? "high" : "normal",
          kind: "overdue_stale",
          headline: `${f.critical ? "קריטי ו" : ""}באיחור ${f.daysOverdue} ימים: ${t.name}`,
          detail: `${where} · סטטוס "${t.status || "לא הוגדר"}"`,
          who,
          project: t.context,
          url: t.url,
        });
      }
      continue;
    }

    // הערה: משימות בלי אחראי כלל לא נמשכות כאן (fetchUserOpsTasks מסנן לפי אדם). "no_owner" ידרוש
    // שאילתה ייעודית של תת-משימות פתוחות בלי person — בהמשך.
  }

  // ---- ממצאים ברמת הפרויקט ----
  for (const p of projects) {
    const openHere = openTeamTasksByProject.get(p.name) ?? 0;

    if (p.status === "תקוע") {
      add({
        key: `projstuck:${p.itemId}`,
        severity: "high",
        kind: "project_stuck",
        headline: `פרויקט תקוע: ${p.name}`,
        detail: `אחראי: ${p.owner || "—"}${p.deliveryDate ? ` · מסירה משוער ${p.deliveryDate}` : ""}`,
        who: p.owner || "מנהל/ת המשרד",
        project: p.name,
      });
    }

    if (p.deliveryDate) {
      const d = DateTime.fromISO(p.deliveryDate, { zone: env.TIMEZONE }).startOf("day");
      if (d < today && !["לקראת מסירה", "הסתיים", "נמכר"].includes(p.status)) {
        add({
          key: `delivery:${p.itemId}`,
          severity: "high",
          kind: "delivery_overdue",
          headline: `עבר תאריך מסירה: ${p.name}`,
          detail: `מסירה משוער ${p.deliveryDate} · סטטוס "${p.status || "לא הוגדר"}"`,
          who: p.owner || "מנהל/ת המשרד",
          project: p.name,
        });
      }
    }

    // stage_gap ("פרויקט פעיל בלי משימה פתוחה") — הושבת ב-v1: הרבה פרויקטים כאן בלי משימות
    // *משויכות* (person ריק), אז openHere=0 לא אומר שאין עבודה. דורש שאילתה שסופרת גם משימות
    // פתוחות בלי אחראי לפני שזה סיגנל אמין.
    void openHere;
  }

  // ---- התחייבויות (מטרה 7) — נרשמות דרך הצ'אט, נבדקות כאן ----
  for (const c of listOpenCommitments()) {
    if (!c.dueDate) continue;
    const due = DateTime.fromISO(c.dueDate, { zone: env.TIMEZONE }).startOf("day");
    const daysPast = Math.floor(today.diff(due, "days").days);
    if (daysPast < 0) continue;
    const owner = resolveUserByKey(c.createdBy)?.name ?? c.createdBy;
    add({
      key: `commitment:${c.id}`,
      severity: daysPast >= 2 ? "high" : "normal",
      kind: "commitment_overdue",
      headline: `התחייבות ${daysPast === 0 ? "להיום" : `באיחור ${daysPast} ימים`}: ${c.what}`,
      detail: `הובטח ל${c.toWhom}${c.project ? ` · פרויקט ${c.project}` : ""} · נרשם ע"י ${owner}`,
      who: owner,
      project: c.project ?? undefined,
    });
  }

  // ---- לקוח מחכה לנו (מטרה 8) ----
  // שני סיגנלים: (א) שלב תקוע ב"ממתין ללקוח" מעל שבועיים — כנראה הלקוח כבר ענה ולא זזנו;
  // (ב) משימה מול-לקוח באיחור שהכדור אצל המשרד.
  const CLIENT_FACING = /פגיש|לקוח|אישור|עדכון לקוח|שליח|החתמ|מייל ללקוח|חזר|תיאום|מצג/;
  for (const t of allTasks) {
    const longWait =
      (t.status === "ממתין ללקוח" || t.status === "ממתין להתייחסות") &&
      t.flags.overdue &&
      t.flags.daysOverdue >= 14;
    const clientFacingOverdue =
      t.flags.overdue &&
      !t.flags.waitingExternal &&
      (!t.responsibleParty || t.responsibleParty === "המשרד") &&
      CLIENT_FACING.test(t.name) &&
      t.flags.daysOverdue >= 3;
    if (!longWait && !clientFacingOverdue) continue;
    add({
      key: `clientwait:${t.itemId}`,
      severity: t.flags.daysOverdue >= 10 ? "high" : "normal",
      kind: "client_waiting",
      headline: longWait
        ? `"ממתין ללקוח" כבר ${t.flags.daysOverdue} ימים: ${t.name}`
        : `לקוח מחכה — באיחור ${t.flags.daysOverdue} ימים: ${t.name}`,
      detail: `${t.stageName ? `${t.context} › ${t.stageName}` : t.context}${
        longWait ? " — כדאי לבדוק אם הלקוח כבר ענה" : ""
      }`,
      who: ownerOf(t, projectOwnerByName.get(t.context)),
      project: t.context,
      url: t.url,
    });
  }

  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

  const counts = { critical: 0, high: 0, normal: 0, total: findings.length };
  for (const f of findings) counts[f.severity]++;

  const byPersonMap = new Map<string, number>();
  for (const f of findings) byPersonMap.set(f.who, (byPersonMap.get(f.who) ?? 0) + 1);

  return {
    generatedAt,
    counts,
    findings,
    forManager: findings.filter((f) => f.severity !== "normal"),
    byPerson: [...byPersonMap.entries()]
      .map(([who, count]) => ({ who, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** נקודת כניסה עם הרשאה — לשרת. */
export async function getControlScan(user: IdentifiedUser): Promise<ControlScanReport> {
  if (!userCan(user, "view:all_work")) {
    throw new Error("אין למשתמש הרשאה למנוע הבקרה");
  }
  return runControlScan();
}
