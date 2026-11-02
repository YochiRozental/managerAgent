/**
 * השלמת פרטי קשר על איש הקשר המקושר לליד — ברקע, בלי ליצור איש קשר.
 *
 * הרקע: אוטומציית Monday (על לוח הלידים) יוצרת ומקשרת איש קשר בכל יצירת ליד, אסינכרונית (שניות ויותר), מעתיקה רק
 * שם/טלפון/מייל/אחראי, ולא מעבירה ווצאפ. עדכון פרטי קשר בליד (update_lead_contact) גם הוא לא מגיע אליו. התור
 * (lead_contact_sync) מנסה שוב עם backoff עד שאיש הקשר מקושר, וכותב אליו רק את העמודות הקיימות.
 *
 * בטיחות (לא שוברים את ההתנהגות הקיימת ולא דורסים עריכה ידנית):
 *  - כותבים שדה רק אם הוא ריק באיש הקשר, או שהוא עדיין שווה לערך הישן של הליד (= היה מסונכרן).
 *  - איש קשר שמקושר גם לליד אחר (משותף) — ממלאים שדה ריק בלבד, לעולם לא דורסים.
 *  - ערך שכבר שווה — לא כותבים (idempotent: הרצה חוזרת לא משנה כלום).
 *  - לא נמצא איש קשר מקושר אחד בדיוק → ממשיכים לנסות; אחרי חלון זמן מודיעים למשתמש ומוותרים. אף פעם לא יוצרים.
 */

import { addNotification } from "../db/repositories/notifications.js";
import {
  claimSyncJob,
  finishSyncJob,
  listDueSyncJobs,
  rescheduleSyncJob,
  type SyncChange,
  type SyncFields,
  type SyncJob,
} from "../db/repositories/leadContactSync.js";
import {
  CONTACT_COLUMNS,
  getContactState,
  getLeadLinkedContactIds,
  updateContactColumns,
  type ContactState,
} from "../integrations/monday/contacts.js";
import { logger } from "../utils/logger.js";
import { toMondayPhone } from "./forms/definitions.js";
import { publishNotificationLive } from "./notificationBus.js";

/** חלון ההמתנה לאוטומציה (או לתיקון תקלה) לפני שמוותרים ומודיעים. */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
export const MAX_ERROR_ATTEMPTS = 12;
const LEASE_MS = 3 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/** 30ש', 1ד', 2ד', 4ד'... עד שעה. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** attempts, MAX_BACKOFF_MS);
}

const digits = (s: string) => s.replace(/\D/g, "").replace(/^972/, "0");
const sameValue = (field: keyof SyncFields, a: string, b: string): boolean => {
  if (field === "phone" || field === "whatsapp") return digits(a) === digits(b);
  if (field === "email") return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
};

export interface ContactPlan {
  columns: Record<string, unknown>;
  applied: (keyof SyncFields)[];
  /** שדות שלא נכתבו ולמה — "already" (כבר שווה) לא מדווח כבעיה */
  skipped: { field: keyof SyncFields; reason: "already" | "conflict" }[];
}

/** פונקציה טהורה: מה לכתוב לאיש הקשר לפי מצבו הנוכחי (ר' כללי הבטיחות בראש הקובץ). */
export function planContactUpdate(contact: ContactState, fields: SyncFields, leadItemId: string): ContactPlan {
  const columns: Record<string, unknown> = {};
  const applied: (keyof SyncFields)[] = [];
  const skipped: ContactPlan["skipped"] = [];
  const shared = contact.leadIds.some((id) => id !== leadItemId);

  const current: Record<keyof SyncFields, string> = {
    whatsapp: contact.whatsapp,
    phone: contact.phone,
    email: contact.email,
    name: contact.name,
  };
  const toColumn: Record<keyof SyncFields, (v: string) => [string, unknown]> = {
    whatsapp: (v) => [CONTACT_COLUMNS.whatsapp, { phone: toMondayPhone(v), countryShortName: "IL" }],
    phone: (v) => [CONTACT_COLUMNS.phone, { phone: toMondayPhone(v), countryShortName: "IL" }],
    email: (v) => [CONTACT_COLUMNS.email, { email: v, text: v }],
    name: (v) => ["name", v],
  };

  for (const key of Object.keys(fields) as (keyof SyncFields)[]) {
    const change = fields[key] as SyncChange | undefined;
    if (!change || !change.new.trim()) continue;
    const cur = current[key];
    if (cur && sameValue(key, cur, change.new)) {
      skipped.push({ field: key, reason: "already" });
      continue;
    }
    const wasInSync = !shared && change.old !== null && cur !== "" && sameValue(key, cur, change.old);
    if (cur === "" || wasInSync) {
      const [col, value] = toColumn[key](change.new);
      columns[col] = value;
      applied.push(key);
    } else {
      skipped.push({ field: key, reason: "conflict" });
    }
  }
  return { columns, applied, skipped };
}

export interface SyncDeps {
  getLinkedContactIds?: (leadItemId: string) => Promise<string[]>;
  getContact?: (contactId: string) => Promise<ContactState | null>;
  updateContact?: (contactId: string, columns: Record<string, unknown>) => Promise<void>;
  notify?: (userKey: string, body: string) => void;
  nowMs?: () => number;
}

const FIELD_LABEL: Record<keyof SyncFields, string> = { whatsapp: "ווצאפ", phone: "טלפון", email: "מייל", name: "שם" };

function defaultNotify(userKey: string, body: string): void {
  const id = addNotification(userKey, "lead_contact_sync", body);
  publishNotificationLive({
    userKey,
    id,
    kind: "lead_contact_sync",
    body,
    findingKey: null,
    itemId: null,
    itemSource: null,
    context: null,
    createdAt: new Date().toISOString(),
  });
}

export interface SyncRunResult {
  claimed: number;
  done: number;
  retried: number;
  gaveUp: number;
}

/** טיפול במשימות שבשלו. כל משימה מבודדת — כשל באחת לא עוצר את האחרות. */
export async function processLeadContactSyncJobs(deps: SyncDeps = {}): Promise<SyncRunResult> {
  const now = deps.nowMs ?? (() => Date.now());
  const result: SyncRunResult = { claimed: 0, done: 0, retried: 0, gaveUp: 0 };
  const jobs = listDueSyncJobs(now());
  for (const job of jobs) {
    if (!claimSyncJob(job.id, now(), LEASE_MS)) continue;
    result.claimed++;
    try {
      const outcome = await processOne(job, deps, now());
      result[outcome]++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const t = now();
      if (job.attempts + 1 >= MAX_ERROR_ATTEMPTS || t - job.createdMs > GIVE_UP_AFTER_MS) {
        giveUp(job, `נכשל: ${msg}`, deps, t);
        result.gaveUp++;
      } else {
        rescheduleSyncJob(job.id, t + backoffMs(job.attempts + 1), `שגיאה: ${msg}`, t);
        result.retried++;
      }
      logger.warn({ err: msg, jobId: job.id, leadItemId: job.leadItemId }, "סנכרון איש קשר: כשל זמני — ינסה שוב");
    }
  }
  return result;
}

function giveUp(job: SyncJob, reason: string, deps: SyncDeps, nowMs: number): void {
  finishSyncJob(job.id, "gave_up", reason, nowMs);
  if (job.userKey) {
    const fields = Object.keys(job.fields).map((k) => FIELD_LABEL[k as keyof SyncFields]).join(", ");
    (deps.notify ?? defaultNotify)(
      job.userKey,
      `לא הצלחתי להעביר (${fields}) מהליד "${job.leadName ?? job.leadItemId}" לאיש הקשר המקושר: ${reason}. הפרטים נשמרו בליד עצמו.`,
    );
  }
}

async function processOne(job: SyncJob, deps: SyncDeps, nowMs: number): Promise<"done" | "retried" | "gaveUp"> {
  const getIds = deps.getLinkedContactIds ?? getLeadLinkedContactIds;
  const getContact = deps.getContact ?? getContactState;
  const update = deps.updateContact ?? updateContactColumns;

  const wait = (reason: string): "retried" | "gaveUp" => {
    if (nowMs - job.createdMs > GIVE_UP_AFTER_MS) {
      giveUp(job, reason, deps, nowMs);
      return "gaveUp";
    }
    rescheduleSyncJob(job.id, nowMs + backoffMs(job.attempts + 1), reason, nowMs);
    return "retried";
  };

  const ids = await getIds(job.leadItemId);
  if (ids.length === 0) return wait("איש הקשר עדיין לא נוצר/לא מקושר לליד");
  if (ids.length > 1) return wait("לליד מקושרים כמה אנשי קשר — לא ידוע איזה לעדכן");

  const contact = await getContact(ids[0]!);
  if (!contact) return wait("איש הקשר המקושר לא נמצא");

  const plan = planContactUpdate(contact, job.fields, job.leadItemId);
  if (Object.keys(plan.columns).length > 0) await update(contact.id, plan.columns);

  const conflicts = plan.skipped.filter((s) => s.reason === "conflict").map((s) => FIELD_LABEL[s.field]);
  const summary =
    `עודכנו: ${plan.applied.map((f) => FIELD_LABEL[f]).join(", ") || "—"}` + (conflicts.length ? ` · לא נדרסו (ערך שונה באיש הקשר): ${conflicts.join(", ")}` : "");
  finishSyncJob(job.id, "done", summary, nowMs);
  if (conflicts.length > 0 && job.userKey) {
    (deps.notify ?? defaultNotify)(
      job.userKey,
      `באיש הקשר המקושר לליד "${job.leadName ?? job.leadItemId}" כבר יש ערך שונה ב${conflicts.join(", ")} — לא דרסתי אותו. הערך החדש נשמר בליד.`,
    );
  }
  return "done";
}
