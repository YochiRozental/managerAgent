/**
 * טפסי יצירה בצ'אט — טיפוסים משותפים לשרת ול-UI (ה-UI מקבל FormPayload כ-JSON ומרנדר מתוכו בלבד).
 * מנגנון אחד לכל סוג פריט: ההגדרה (definitions.ts) קובעת שדות/חובה/ולידציה, הקלט עובר אותה ולא לוגיקה
 * פר-טופס. היצירה עצמה נשארת בפונקציות ה-*Action הקיימות (ops/actions.ts) — הטופס רק אוסף קלט.
 */

import type { FormStatus } from "../../db/repositories/formRequests.js";

export type FormKind = "lead" | "task" | "stage" | "commitment";

export type FormFieldType = "text" | "textarea" | "tel" | "email" | "select" | "date";

/** מקור אפשרויות דינמי (נטען ב-GET /api/forms/options; לא נשמר בהגדרה) */
export type OptionsSource = "projects" | "stages" | "people" | "lead_source" | "lead_product" | "task_priority";

export interface FormFieldDef {
  name: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  placeholder?: string;
  maxLength?: number;
  /** אפשרויות קבועות (select) */
  options?: { value: string; label: string }[];
  /** אפשרויות דינמיות (select) */
  optionsSource?: OptionsSource;
  /** שדה שהאפשרויות שלו תלויות בערך של שדה אחר (למשל שלב ← פרויקט) */
  dependsOn?: string;
  /** השדה מוצג (וחל עליו required) רק כשערך field נמצא ב-in */
  showWhen?: { field: string; in: string[] };
  /** מאפשר סימון מפורש "אין" — שונה משדה שלא מולא */
  allowNone?: boolean;
  /** טקסט האפשרות הריקה ב-select (למשל "אני") */
  emptyLabel?: string;
  defaultValue?: string;
  hint?: string;
}

export interface FormDefinition {
  kind: FormKind;
  title: string;
  submitLabel: string;
  fields: FormFieldDef[];
}

export type FormValues = Record<string, string>;
export type FormNone = Record<string, boolean>;

export interface FormPrefill {
  values: FormValues;
  none: FormNone;
}

export interface FormResult {
  message: string;
  url?: string | null;
  itemId?: string | null;
  warnings?: string[];
  /** הודעות מידע (לא בעיה): למשל "הווצאפ יועבר לאיש הקשר ברקע" */
  notes?: string[];
}

/** מה שהלקוח מקבל ומרנדר */
export interface FormPayload {
  id: string;
  kind: FormKind;
  title: string;
  submitLabel: string;
  status: FormStatus;
  fields: FormFieldDef[];
  values: FormValues;
  none: FormNone;
  error?: string | null;
  result?: FormResult | null;
}
