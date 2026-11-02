/**
 * API של טפסי היצירה בצ'אט. שכבה דקה מעל ops/forms/service.ts — כל ההרשאות/הלוגיקה שם; כאן רק פענוח בקשה
 * ומיפוי שגיאות. כמו teamApi.ts: מקבל בקשה מפוענחת ומחזיר {status, body} (בלי req/res) כדי שאפשר לבדוק
 * ישירות. הזהות מגיעה אך ורק מ-`user` (עוגייה מאומתת); בעלות על טופס נבדקת ב-service.
 */

import type { IdentifiedUser } from "../identity/index.js";
import { FormError, cancelForm, getForm, submitForm, type FormServiceDeps } from "../ops/forms/service.js";
import { resolveOptions, type OptionsDeps } from "../ops/forms/options.js";
import type { OptionsSource } from "../ops/forms/types.js";
import { logger } from "../utils/logger.js";

export interface FormsRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  readBody: () => Promise<Record<string, unknown>>;
  user: IdentifiedUser | null;
}

export interface FormsResponse {
  status: number;
  body: unknown;
}

export function isFormsPath(path: string): boolean {
  return path.startsWith("/api/forms/");
}

const SOURCES: readonly OptionsSource[] = ["projects", "stages", "people", "lead_source", "lead_product", "task_priority"];

export async function handleFormsRequest(
  req: FormsRequest,
  deps: { service?: FormServiceDeps; options?: OptionsDeps } = {},
): Promise<FormsResponse> {
  if (!req.user) return { status: 401, body: { error: "לא מחובר" } };
  const user = req.user;
  const body = req.method === "POST" ? await req.readBody() : {};
  const bodyId = typeof body.id === "string" ? body.id : "";

  try {
    if (req.method === "GET" && req.path === "/api/forms/get") {
      const form = getForm(user, req.query.get("id") ?? "");
      return form ? { status: 200, body: { form } } : { status: 404, body: { error: "הטופס לא נמצא" } };
    }

    if (req.method === "GET" && req.path === "/api/forms/options") {
      const source = req.query.get("source") as OptionsSource | null;
      if (!source || !SOURCES.includes(source)) return { status: 400, body: { error: "מקור אפשרויות לא מוכר" } };
      const options = await resolveOptions(source, user, { project: req.query.get("project") ?? undefined }, deps.options);
      return { status: 200, body: { options } };
    }

    if (req.method === "POST" && req.path === "/api/forms/submit") {
      const out = await submitForm(user, bodyId, { values: body.values, none: body.none }, deps.service);
      return {
        status: 200,
        body: { ok: true, form: out.form, confirmation: out.confirmation, alreadySubmitted: out.alreadySubmitted },
      };
    }

    if (req.method === "POST" && req.path === "/api/forms/cancel") {
      const form = cancelForm(user, bodyId);
      return { status: 200, body: { ok: true, form } };
    }
  } catch (err) {
    if (err instanceof FormError) {
      // טופס שנכשל ביצירה חוזר ל-open — מחזירים אותו כדי שה-UI יציג את השגיאה על אותו טופס
      const form = req.path === "/api/forms/submit" ? getForm(user, bodyId) : null;
      return { status: err.status, body: { error: err.message, fieldErrors: err.fieldErrors, ...(form ? { form } : {}) } };
    }
    logger.error({ err, user: user.key, path: req.path }, "שגיאה בטופס יצירה");
    return { status: 500, body: { error: "שגיאה פנימית — נסה/י שוב" } };
  }

  return { status: 404, body: { error: "לא נמצא" } };
}
