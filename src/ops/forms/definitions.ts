/**
 * הגדרות הטפסים לכל סוג פריט + ולידציה/נרמול משותפים. שדות, חובה, ברירות מחדל ותנאי הצגה מוגדרים כאן
 * כנתונים; אין קוד ולידציה פר-טופס. ההרשאה האמיתית נאכפת בפונקציות ה-*Action בעת היצירה — canUseForm
 * רק שער הפתיחה (אותם תנאי חשיפה שהיו לכלי היצירה הקיימים בצ'אט).
 */

import { DateTime } from "luxon";
import { userCan, type IdentifiedUser } from "../../identity/index.js";
import type { FormDefinition, FormFieldDef, FormKind, FormNone, FormPrefill, FormValues } from "./types.js";

/** שער הפתיחה: זהה לתנאי חשיפת כלי היצירה הקיימים (chat.ts canCreateTask/canCreateLead/canManageProjectStages). */
export function canUseForm(user: IdentifiedUser, kind: FormKind): boolean {
  switch (kind) {
    case "lead":
      return userCan(user, "lead:manage");
    case "task":
      return userCan(user, "task:create") || userCan(user, "task:manage");
    case "stage":
      return userCan(user, "project:manage");
    case "commitment":
      return true;
  }
}

const SCOPE_OPTIONS = [
  { value: "general", label: "משימה כללית (בלי פרויקט)" },
  { value: "project", label: "מקושרת לפרויקט" },
  { value: "stage", label: "תחת שלב בפרויקט" },
];

const DEFINITIONS: Record<FormKind, FormDefinition> = {
  lead: {
    kind: "lead",
    title: "ליד חדש",
    submitLabel: "צור פריט",
    fields: [
      { name: "contactName", label: "שם איש קשר", type: "text", required: true },
      { name: "phone", label: "מספר טלפון", type: "tel", required: true },
      { name: "projectName", label: "שם הפרויקט / הליד", type: "text", required: true },
      { name: "projectType", label: "סוג הפרויקט", type: "select", optionsSource: "lead_product", required: true },
      { name: "email", label: "כתובת מייל", type: "email", allowNone: true },
      { name: "whatsapp", label: "מספר ווצאפ", type: "tel", allowNone: true },
      { name: "institutionName", label: "שם עמותה / קהילה / מוסד", type: "text" },
      { name: "source", label: "מקור הגעה", type: "select", optionsSource: "lead_source", emptyLabel: "לא צוין" },
      { name: "referredBy", label: "מפנה הליד", type: "text" },
      { name: "assignee", label: "אחראי/ת", type: "select", optionsSource: "people", emptyLabel: "אני" },
    ],
  },
  task: {
    kind: "task",
    title: "משימה חדשה",
    submitLabel: "צור פריט",
    fields: [
      { name: "taskName", label: "מה המשימה", type: "text", required: true },
      { name: "scope", label: "סוג המשימה", type: "select", options: SCOPE_OPTIONS, required: true, defaultValue: "general" },
      {
        name: "project",
        label: "פרויקט",
        type: "select",
        optionsSource: "projects",
        required: true,
        showWhen: { field: "scope", in: ["project", "stage"] },
      },
      {
        name: "stage",
        label: "שלב",
        type: "select",
        optionsSource: "stages",
        dependsOn: "project",
        required: true,
        showWhen: { field: "scope", in: ["stage"] },
      },
      { name: "assignee", label: "אחראי/ת", type: "select", optionsSource: "people", emptyLabel: "אני" },
      { name: "dueDate", label: "תאריך יעד", type: "date" },
      { name: "priority", label: "תעדוף", type: "select", optionsSource: "task_priority", emptyLabel: "ללא" },
    ],
  },
  stage: {
    kind: "stage",
    title: "שלב חדש בפרויקט",
    submitLabel: "צור פריט",
    fields: [
      { name: "project", label: "פרויקט", type: "select", optionsSource: "projects", required: true },
      { name: "name", label: "שם השלב", type: "text", required: true },
    ],
  },
  commitment: {
    kind: "commitment",
    title: "התחייבות חדשה",
    submitLabel: "שמור התחייבות",
    fields: [
      { name: "toWhom", label: "למי הובטח", type: "text", required: true, hint: "לקוח / יועץ / גורם חוץ — לא את עצמך" },
      { name: "what", label: "מה הובטח", type: "textarea", required: true },
      { name: "dueDate", label: "תאריך יעד", type: "date" },
      { name: "project", label: "פרויקט (אם רלוונטי)", type: "text" },
    ],
  },
};

export function getFormDefinition(kind: FormKind): FormDefinition {
  return DEFINITIONS[kind];
}

export const FORM_KINDS = Object.keys(DEFINITIONS) as FormKind[];

// ───────────────────────── prefill ─────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown, max: number): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v).trim().slice(0, max);
}

/**
 * ממפה את הקלט החלקי שהמודל העביר לכלי (מה שהמשתמש כבר אמר) לערכי טופס. רק מילוי מראש — הכל ניתן לעריכה,
 * והוולידציה האמיתית רצה בשליחה. ערך לא תקין (תאריך שבור, scope לא מוכר) נזרק בשקט במקום לעבור הלאה.
 */
export function buildPrefill(kind: FormKind, input: Record<string, unknown>): FormPrefill {
  const def = getFormDefinition(kind);
  const values: FormValues = {};
  const none: FormNone = {};

  const raw: Record<string, string> = {};
  for (const f of def.fields) raw[f.name] = str(input[f.name], f.maxLength ?? (f.type === "textarea" ? 2000 : 500));

  if (kind === "lead") {
    // תאימות לשמות הישנים של הכלי: firstName/lastName
    if (!raw.contactName) {
      raw.contactName = [str(input.firstName, 100), str(input.lastName, 100)].filter(Boolean).join(" ");
    }
    if (!raw.projectType) raw.projectType = str(input.product, 200);
    if (input.email === "none") none.email = true;
    if (input.whatsapp === "none") none.whatsapp = true;
  }

  if (kind === "task") {
    const taskKind = str(input.taskKind, 20);
    if (raw.stage || taskKind === "stage") raw.scope = "stage";
    else if (taskKind === "project") raw.scope = "project";
    else if (!raw.project) raw.scope = "general";
    // project בלי מידע על סוג השיוך → לא מחליטים בשם המשתמש; scope נשאר ריק והטופס דורש בחירה.
  }

  for (const f of def.fields) {
    let v = raw[f.name] ?? "";
    if (!v) continue;
    if (f.type === "date" && !DATE_RE.test(v)) continue;
    if (f.options && !f.options.some((o) => o.value === v)) continue;
    if (none[f.name]) continue;
    values[f.name] = v;
  }
  if (kind === "task" && values.scope === undefined && !raw.project) values.scope = "general";
  return { values, none };
}

// ───────────────────────── validation ─────────────────────────

export function isFieldVisible(field: FormFieldDef, values: FormValues): boolean {
  if (!field.showWhen) return true;
  return field.showWhen.in.includes(values[field.showWhen.field] ?? "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** טלפון ישראלי/בינלאומי סביר: ספרות, +, מקף, רווחים, סוגריים; 9–13 ספרות. */
export function isValidPhone(v: string): boolean {
  if (!/^\+?[0-9\s\-()]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 13;
}

/**
 * הפורמט ש-Monday מקבל לעמודת phone (כמו ב-Monday הקיים: 0524446436): ספרות בלבד. מקפים/רווחים/סוגריים נדחים
 * ("invalid value"), ו-+972/972 מומרים ל-0 המוביל. נמצא בבדיקה חיה ב-2026-11-02 — הוולידציה בטופס מאשרת "050-123-4567"
 * אבל Monday דוחה אותו, לכן מנקים לפני כל כתיבה (ליד + איש קשר).
 */
export function toMondayPhone(v: string): string {
  const d = v.replace(/\D/g, "");
  return d.startsWith("972") ? "0" + d.slice(3) : d;
}

export interface NormalizedForm {
  values: FormValues;
  none: FormNone;
  errors: Record<string, string>;
}

/**
 * נרמול + ולידציה של הקלט מהלקוח מול ההגדרה. מחזיר רק שדות מוכרים ונראים; שדות לא מוכרים נזרקים. לא
 * בודק חברוּת באפשרויות דינמיות (זה async ב-service.ts) — רק אפשרויות קבועות.
 */
export function normalizeAndValidate(
  def: FormDefinition,
  rawValues: Record<string, unknown>,
  rawNone: Record<string, unknown> = {},
): NormalizedForm {
  const values: FormValues = {};
  const none: FormNone = {};
  const errors: Record<string, string> = {};

  for (const f of def.fields) {
    const max = f.maxLength ?? (f.type === "textarea" ? 2000 : 500);
    const v = typeof rawValues[f.name] === "string" ? (rawValues[f.name] as string).trim().slice(0, max) : "";
    if (v) values[f.name] = v;
    if (f.allowNone && rawNone[f.name] === true) none[f.name] = true;
  }

  for (const f of def.fields) {
    if (!isFieldVisible(f, values)) {
      delete values[f.name];
      continue;
    }
    if (none[f.name]) {
      delete values[f.name]; // "אין" גובר על ערך שהושאר בשדה
      continue;
    }
    const v = values[f.name] ?? "";
    if (!v) {
      if (f.required) errors[f.name] = "שדה חובה";
      continue;
    }
    if (f.type === "tel" && !isValidPhone(v)) errors[f.name] = "מספר טלפון לא תקין";
    else if (f.type === "email" && !EMAIL_RE.test(v)) errors[f.name] = "כתובת מייל לא תקינה";
    else if (f.type === "date") {
      const d = DATE_RE.test(v) ? DateTime.fromISO(v) : null;
      if (!d || !d.isValid) errors[f.name] = "תאריך לא תקין";
    } else if (f.options && !f.options.some((o) => o.value === v)) {
      errors[f.name] = "ערך לא חוקי";
    }
  }
  return { values, none, errors };
}
