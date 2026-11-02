/**
 * שירות הטפסים: פתיחה (מהכלי בצ'אט), קריאה, ביטול ושליחה. הלוגיקה העסקית של היצירה נשארת בפונקציות
 * ה-*Action הקיימות (ops/actions.ts) — כאן רק: בעלות על הטופס, ולידציה מול ההגדרה, אידמפוטנטיות לפי
 * מזהה הטופס (claim אטומי ב-form_requests), והמרת התוצאה להודעת אישור אמיתית.
 *
 * אידמפוטנטיות: מזהה הטופס הוא המפתח — לא תוכן הפריט. לכן ה-idempotent_creations הקיים (מפתח לפי תוכן)
 * מנוטרל בנתיב הזה (getCachedCreation→null / recordCreation→no-op) ויצירה מכוונת של פריטים זהים אפשרית;
 * לחיצה כפולה על אותו טופס מחזירה את התוצאה השמורה ולא יוצרת שוב. הצלחה מוצגת רק אחרי שה-Action חזר
 * (כלומר Monday אישר).
 */

import { createHash, randomUUID } from "node:crypto";
import { appendAssistantMessage } from "../../db/repositories/chatHistory.js";
import {
  cancelFormRequest,
  claimFormForSubmit,
  createFormRequest,
  getFormRequest,
  markFormSubmitted,
  findFormByCreatedItem,
  releaseFormToOpen,
  saveFormCheckpoint,
  type FormRequestRow,
} from "../../db/repositories/formRequests.js";
import { addCommitment, findRecentCommitments } from "../../db/repositories/commitments.js";
import { enqueueLeadContactSync } from "../../db/repositories/leadContactSync.js";
import type { IdentifiedUser } from "../../identity/index.js";
import { LEADS_BOARD_ID } from "../../integrations/monday/leads.js";
import { BOARD_PROJECT_STAGES, mondayItemUrl } from "../../integrations/monday/opsRead.js";
import { addTaskNote } from "../../integrations/monday/opsWrite.js";
import { createLeadAction, createProjectStageAction, createTaskAction } from "../actions.js";
import {
  buildPrefill,
  canUseForm,
  toMondayPhone,
  getFormDefinition,
  isFieldVisible,
  normalizeAndValidate,
} from "./definitions.js";
import { resolveOptions, type OptionsDeps } from "./options.js";
import { findCreatedInMonday, targetFor, type FindCreatedFn } from "./reconcile.js";
import type { FormKind, FormNone, FormPayload, FormPrefill, FormResult, FormValues } from "./types.js";

const MONDAY_HOST = "https://gottlieb-league.monday.com";

export interface FormServiceDeps {
  createLeadAction?: typeof createLeadAction;
  createTaskAction?: typeof createTaskAction;
  createProjectStageAction?: typeof createProjectStageAction;
  addCommitment?: typeof addCommitment;
  addUpdate?: (itemId: string, body: string) => Promise<void>;
  appendHistory?: (userKey: string, sessionId: string | null, text: string) => void;
  options?: OptionsDeps;
  /** תור ההשלמה ברקע של ווצאפ על איש הקשר שאוטומציית Monday יצרה וקישרה לליד (ר' ops/leadContactSync.ts) */
  enqueueContactSync?: typeof enqueueLeadContactSync;
  /** התאמת מצב אחרי ניתוק: חיפוש פריט שניסיון קודם כבר יצר ב-Monday (ר' reconcile.ts) */
  findCreated?: FindCreatedFn;
  findCommitments?: typeof findRecentCommitments;
}

export class FormError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

function kindLabel(kind: FormKind): string {
  return { lead: "ליד", task: "משימה", stage: "שלב", commitment: "התחייבות" }[kind];
}

function toPayload(row: FormRequestRow): FormPayload {
  const def = getFormDefinition(row.kind as FormKind);
  const prefill = JSON.parse(row.prefillJson) as FormPrefill;
  return {
    id: row.id,
    kind: def.kind,
    title: def.title,
    submitLabel: def.submitLabel,
    status: row.status,
    fields: def.fields,
    values: prefill.values,
    none: prefill.none,
    error: row.lastError,
    result: row.resultJson ? (JSON.parse(row.resultJson) as FormResult) : null,
  };
}

/** מזהה דטרמיניסטי כשיש seed (clientMessageId) — retry/fallback של אותה הודעה לא פותח טופס נוסף. */
function formIdFor(user: IdentifiedUser, kind: FormKind, sessionId: string | null, seed?: string): string {
  if (!seed) return `f_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  return `f_${createHash("sha1").update(`${user.key}|${sessionId ?? ""}|${kind}|${seed}`).digest("hex").slice(0, 20)}`;
}

export function openForm(
  user: IdentifiedUser,
  kind: FormKind,
  input: Record<string, unknown>,
  ctx: { sessionId: string | null; seed?: string },
): FormPayload {
  if (!canUseForm(user, kind)) throw new FormError(`אין לך הרשאה ליצור ${kindLabel(kind)}`, 403);
  const row = createFormRequest({
    id: formIdFor(user, kind, ctx.sessionId, ctx.seed),
    userKey: user.key,
    sessionId: ctx.sessionId,
    kind,
    prefill: buildPrefill(kind, input),
  });
  return toPayload(row);
}

/** הטופס רק לבעליו; אחרת null (בלי לחשוף קיום). */
export function getForm(user: IdentifiedUser, id: string): FormPayload | null {
  const row = getFormRequest(id);
  return row && row.userKey === user.key ? toPayload(row) : null;
}

export function cancelForm(user: IdentifiedUser, id: string): FormPayload {
  const row = getFormRequest(id);
  if (!row || row.userKey !== user.key) throw new FormError("הטופס לא נמצא", 404);
  cancelFormRequest(id, user.key); // רק open → cancelled; כל מצב אחר נשאר כפי שהוא
  return toPayload(getFormRequest(id)!);
}

// ───────────────────────── submit ─────────────────────────

export interface SubmitOutcome {
  form: FormPayload;
  /** טקסט האישור שנשמר גם בהיסטוריית השיחה (markdown מינימלי עם קישור) */
  confirmation: string;
  /** true כשזו לחיצה חוזרת על טופס שכבר נשלח — לא נוצר דבר חדש */
  alreadySubmitted: boolean;
}

export function confirmationText(kind: FormKind, result: FormResult): string {
  const icon = kind === "commitment" ? "🤝" : "🆕";
  let text = `${icon} ${result.message}`;
  if (result.url) text += ` — [פתח ב-Monday](${result.url})`;
  for (const n of result.notes ?? []) text += `\nℹ️ ${n}`;
  for (const w of result.warnings ?? []) text += `\n⚠️ ${w}`;
  return text;
}

async function checkDynamicOptions(
  user: IdentifiedUser,
  kind: FormKind,
  values: FormValues,
  deps: OptionsDeps,
): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const f of getFormDefinition(kind).fields) {
    if (!f.optionsSource || !isFieldVisible(f, values)) continue;
    const v = values[f.name];
    if (!v) continue;
    const options = await resolveOptions(f.optionsSource, user, { project: f.dependsOn ? values[f.dependsOn] : undefined }, deps);
    if (options !== null && !options.includes(v)) errors[f.name] = "ערך לא חוקי — בחר/י מהרשימה";
  }
  return errors;
}

export async function submitForm(
  user: IdentifiedUser,
  id: string,
  body: { values?: unknown; none?: unknown },
  deps: FormServiceDeps = {},
): Promise<SubmitOutcome> {
  const row = getFormRequest(id);
  if (!row || row.userKey !== user.key) throw new FormError("הטופס לא נמצא", 404);
  const kind = row.kind as FormKind;

  const done = (r: FormRequestRow, already: boolean): SubmitOutcome => {
    const form = toPayload(r);
    return { form, confirmation: confirmationText(kind, form.result!), alreadySubmitted: already };
  };
  if (row.status === "submitted") return done(row, true);
  if (row.status === "cancelled") throw new FormError("הטופס בוטל", 409);

  if (!canUseForm(user, kind)) throw new FormError(`אין לך הרשאה ליצור ${kindLabel(kind)}`, 403);

  const def = getFormDefinition(kind);
  const rawValues = body.values && typeof body.values === "object" ? (body.values as Record<string, unknown>) : {};
  const rawNone = body.none && typeof body.none === "object" ? (body.none as Record<string, unknown>) : {};
  const norm = normalizeAndValidate(def, rawValues, rawNone);
  const errors = { ...norm.errors };
  if (Object.keys(errors).length === 0) Object.assign(errors, await checkDynamicOptions(user, kind, norm.values, deps.options ?? {}));
  if (Object.keys(errors).length > 0) throw new FormError("יש שדות שצריך לתקן", 400, errors);

  if (!claimFormForSubmit(id, user.key)) {
    const cur = getFormRequest(id)!;
    if (cur.status === "submitted") return done(cur, true);
    throw new FormError("הטופס כבר בעיבוד — נסה/י שוב בעוד רגע", 409);
  }

  // הניסיון הזה: מספר הניסיון, תחילת הניסיון הראשון, ו-checkpoint של ניסיון קודם (אם הפריט כבר נוצר).
  const claimed = getFormRequest(id)!;
  const ctx: ExecCtx = {
    formId: id,
    attempts: claimed.attempts,
    firstAttemptMs: claimed.firstAttemptMs ?? Date.now(),
    checkpoint: claimed.checkpointJson ? (JSON.parse(claimed.checkpointJson) as Checkpoint) : {},
    save(c) {
      this.checkpoint = c;
      saveFormCheckpoint(id, c);
    },
  };

  let result: FormResult;
  try {
    result = await executeKind(user, kind, norm.values, norm.none, deps, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    releaseFormToOpen(id, msg);
    throw err instanceof FormError ? err : new FormError(msg, 422);
  }

  markFormSubmitted(id, result);
  const confirmation = confirmationText(kind, result);
  try {
    (deps.appendHistory ?? ((u, s, t) => (s ? appendAssistantMessage(u, s, t) : undefined)))(user.key, row.sessionId, confirmation);
  } catch {
    /* ההיסטוריה היא נוחות — היצירה כבר הצליחה */
  }
  return { form: toPayload(getFormRequest(id)!), confirmation, alreadySubmitted: false };
}

// ───────────────────────── per-kind execution ─────────────────────────

// מנטרל את ה-idempotency לפי תוכן של ה-Actions הקיימים — כאן המפתח הוא מזהה הטופס (claim אטומי).
const NO_CONTENT_DEDUP = { getCachedCreation: () => null, recordCreation: () => undefined } as const;

interface Created {
  itemId: string | null;
  itemName: string;
  message: string;
  url?: string | null;
}
/** מצב שנשמר ב-DB מיד אחרי היצירה: ניסיון חוזר (גם אחרי קריסה) ממשיך משם ולא יוצר שוב. */
interface Checkpoint {
  created?: Created;
  /** נמצא פריט שנוצר בניסיון קודם (לא נוצר מחדש) */
  adopted?: boolean;
  notesDone?: boolean;
  syncQueued?: boolean;
}
interface ExecCtx {
  formId: string;
  attempts: number;
  firstAttemptMs: number;
  checkpoint: Checkpoint;
  save: (c: Checkpoint) => void;
}

const itemUrl = (boardId: string, itemId: string) => `${MONDAY_HOST}/boards/${boardId}/pulses/${itemId}`;

/**
 * יוצר פעם אחת לכל טופס. סדר ההגנות: (1) checkpoint קיים → משתמשים בו; (2) ניסיון שני ומעלה בלי checkpoint =
 * ייתכן שהניסיון הקודם יצר ונקטע — מחפשים פריט שנוצר מאז תחילת הניסיון הראשון; נמצא → מאמצים; לא ניתן לוודא או
 * יש כמה מועמדים → לא יוצרים (שגיאה, לא כפילות); (3) יוצרים וכותבים checkpoint מיד, לפני כל שלב המשך.
 */
async function createOnce(
  kind: FormKind,
  user: IdentifiedUser,
  v: FormValues,
  deps: FormServiceDeps,
  ctx: ExecCtx,
  create: () => Promise<Created>,
): Promise<Created> {
  if (ctx.checkpoint.created) return ctx.checkpoint.created;

  if (ctx.attempts > 1) {
    const existing = await findExistingCreation(kind, user, v, deps, ctx);
    if (existing) {
      ctx.save({ ...ctx.checkpoint, created: existing, adopted: true });
      return existing;
    }
  }

  const created = await create();
  ctx.save({ ...ctx.checkpoint, created });
  return created;
}

async function findExistingCreation(kind: FormKind, user: IdentifiedUser, v: FormValues, deps: FormServiceDeps, ctx: ExecCtx): Promise<Created | null> {
  const unsure = (why: string) =>
    new FormError(
      `לא ניתן לוודא שהפריט לא נוצר כבר בניסיון הקודם (${why}). בדוק/י ב-Monday: אם הוא קיים — אין צורך ביצירה; אם לא — בטל/י את הטופס ופתח/י טופס חדש.`,
      409,
    );

  if (kind === "commitment") {
    const found = (deps.findCommitments ?? findRecentCommitments)(user.key, v.toWhom ?? "", v.what ?? "", ctx.firstAttemptMs);
    const free = found.filter((c) => !findFormByCreatedItem(String(c.id), ctx.formId));
    if (free.length === 0) return null;
    const c = free[0]!;
    return { itemId: String(c.id), itemName: c.what, message: `ההתחייבות כבר נשמרה בניסיון קודם של הטופס הזה — לא שמרתי כפילות: ${c.toWhom} — ${c.what}` };
  }

  let candidates;
  try {
    candidates = await (deps.findCreated ?? findCreatedInMonday)(kind, v, ctx.firstAttemptMs);
  } catch (err) {
    throw unsure(err instanceof Error ? err.message : String(err));
  }
  // פריט שכבר שייך לטופס אחר (יצירה מכוונת של זהים) אינו שלנו
  const free = candidates.filter((c) => !findFormByCreatedItem(c.itemId, ctx.formId));
  if (free.length === 0) return null;
  if (free.length > 1) throw unsure(`נמצאו ${free.length} פריטים תואמים`);
  const target = targetFor(kind, v)!;
  const hit = free[0]!;
  return {
    itemId: hit.itemId,
    itemName: hit.name,
    message: `הפריט "${hit.name}" כבר נוצר בניסיון קודם של הטופס הזה — לא יצרתי כפילות.`,
    url: itemUrl(target.boardId, hit.itemId),
  };
}

async function executeKind(
  user: IdentifiedUser,
  kind: FormKind,
  v: FormValues,
  none: FormNone,
  deps: FormServiceDeps,
  ctx: ExecCtx,
): Promise<FormResult> {
  switch (kind) {
    case "task": {
      const c = await createOnce(kind, user, v, deps, ctx, async () => {
        const res = await (deps.createTaskAction ?? createTaskAction)(
          user,
          {
            taskName: v.taskName!,
            project: v.scope === "general" ? undefined : v.project,
            taskKind: v.scope === "project" ? "project" : v.scope === "stage" ? "stage" : undefined,
            stage: v.scope === "stage" ? v.stage : undefined,
            assignee: v.assignee,
            dueDate: v.dueDate,
            priority: v.priority,
          },
          NO_CONTENT_DEDUP,
        );
        return { itemId: res.itemId, itemName: res.itemName, message: res.message, url: mondayItemUrl(res.itemId, res.source) };
      });
      return { message: c.message, itemId: c.itemId, url: c.url };
    }
    case "stage": {
      const c = await createOnce(kind, user, v, deps, ctx, async () => {
        const res = await (deps.createProjectStageAction ?? createProjectStageAction)(
          user,
          { project: v.project!, stageName: v.name! },
          NO_CONTENT_DEDUP,
        );
        return { itemId: res.itemId, itemName: res.itemName, message: res.message, url: itemUrl(BOARD_PROJECT_STAGES, res.itemId) };
      });
      return { message: c.message, itemId: c.itemId, url: c.url };
    }
    case "commitment": {
      const toWhom = v.toWhom!;
      if (toWhom.toLowerCase() === user.key.toLowerCase() || toWhom === user.name) {
        throw new Error("התחייבות היא הבטחה לצד שלישי (לקוח / יועץ / גורם חוץ) — אי אפשר לרשום אותה לעצמך.");
      }
      const c = await createOnce(kind, user, v, deps, ctx, async () => {
        const row = (deps.addCommitment ?? addCommitment)({ createdBy: user.key, toWhom, what: v.what!, dueDate: v.dueDate, project: v.project });
        return {
          itemId: String(row.id),
          itemName: row.what,
          message: `נשמר ביומן ההתחייבויות הפתוח שלך (לא נשלח לאף אחד ולא נרשם ב-Monday): ${row.toWhom} — ${row.what}`,
        };
      });
      return { message: c.message };
    }
    case "lead":
      return executeLead(user, v, none, deps, ctx);
  }
}

async function executeLead(user: IdentifiedUser, v: FormValues, none: FormNone, deps: FormServiceDeps, ctx: ExecCtx): Promise<FormResult> {
  const created = await createOnce("lead", user, v, deps, ctx, async () => {
    const [firstName, ...rest] = v.contactName!.split(/\s+/);
    const [productOptions, sourceOptions] = await Promise.all([
      resolveOptions("lead_product", user, {}, deps.options),
      resolveOptions("lead_source", user, {}, deps.options),
    ]);
    const phone = v.phone ? toMondayPhone(v.phone) : undefined;
    const whatsapp = v.whatsapp ? toMondayPhone(v.whatsapp) : undefined;
    const whatsappSameAsPhone = !!whatsapp && whatsapp === phone;

    const res = await (deps.createLeadAction ?? createLeadAction)(
      user,
      {
        firstName,
        lastName: rest.join(" ") || undefined,
        institutionName: v.institutionName,
        // שם הפריט בלוח הלידים = שם הפרויקט / הליד. איש הקשר נשמר בעמודותיו (פרטי/משפחה/טלפון/מייל/ווצאפ)
        // ואוטומציית Monday הקיימת יוצרת ומקשרת ממנו פריט בלוח "אנשי קשר".
        itemName: v.projectName!,
        phone,
        email: v.email,
        // ווצאפ זהה לנייד → תיבת "?מקבל ווצאפ" (אוטומציה מעתיקה); שונה → עמודת הווצאפ ישירות (ר' CreateLeadInput)
        whatsapp: whatsappSameAsPhone ? undefined : whatsapp,
        whatsappSameAsPhone,
        source: v.source,
        product: v.projectType,
        referredBy: v.referredBy,
        assignee: v.assignee,
      },
      {
        ...NO_CONTENT_DEDUP,
        ...(productOptions ? { productOptions } : {}),
        ...(sourceOptions ? { sourceOptions } : {}),
      },
    );
    return { itemId: res.itemId, itemName: res.itemName, message: res.message, url: itemUrl(LEADS_BOARD_ID, res.itemId) };
  });
  const itemId = created.itemId!;

  const warnings: string[] = [];
  const notes: string[] = [];

  // "אין" מפורש (≠ שדה שלא מולא) מתועד כ-Update על הליד — אין עמודה ל"אין" ואסור להוסיף עמודות.
  const lines: string[] = [];
  if (none.email) lines.push("אין כתובת מייל לאיש הקשר (סומן במפורש בטופס יצירת הליד).");
  if (none.whatsapp) lines.push("אין מספר ווצאפ לאיש הקשר (סומן במפורש בטופס יצירת הליד).");
  if (lines.length > 0 && !ctx.checkpoint.notesDone) {
    try {
      await (deps.addUpdate ?? addTaskNote)(itemId, lines.join("\n"));
      ctx.save({ ...ctx.checkpoint, notesDone: true });
    } catch (err) {
      warnings.push(`הליד נוצר, אבל לא הצלחתי לתעד ב-Update את הסימון "אין" (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  // האוטומציה יוצרת את איש הקשר ומקשרת אותו אסינכרונית ולא מעבירה ווצאפ — משלימים על אותו איש קשר ברקע (תור עם
  // retry שורד ריסטרט; ר' ops/leadContactSync.ts). אף פעם לא יוצרים איש קשר, ולא מחכים כאן.
  if (v.whatsapp && !ctx.checkpoint.syncQueued) {
    (deps.enqueueContactSync ?? enqueueLeadContactSync)({
      idemKey: `form:${ctx.formId}`,
      leadItemId: itemId,
      leadName: created.itemName,
      userKey: user.key,
      source: "form_create",
      fields: { whatsapp: { old: null, new: toMondayPhone(v.whatsapp) } },
    });
    ctx.save({ ...ctx.checkpoint, syncQueued: true });
  }
  if (v.whatsapp) notes.push("הווצאפ יועבר לאיש הקשר המקושר ברקע ברגע שהאוטומציה של Monday תיצור אותו (מנסים שוב אוטומטית).");

  return {
    message: created.message,
    itemId,
    url: created.url,
    ...(notes.length ? { notes } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
