/**
 * כלי הצ'אט (Web בלבד) שפותחים טופס יצירה במקום ליצור ישירות. אותם שמות כלים כמו הכלים הקיימים
 * (create_task / create_lead / create_project_stage / record_commitment) — כך שהמודל ממשיך לבחור לפי
 * אותה כוונה, אבל בחלונית כל יצירה ידנית עוברת דרך הטופס. הכלים המשותפים ב-ops/agentTools.ts (שמשרתים את
 * WhatsApp) לא משתנים בכלל.
 *
 * הכלי רק פותח טופס ממולא-מראש ומחזיר למודל הוראה ברורה לא לטעון שנוצר משהו. היצירה בפועל קורית
 * ב-POST /api/forms/submit (service.ts), אחרי שהמשתמש אישר.
 */

import type { IdentifiedUser } from "../../identity/index.js";
import { FormError, openForm } from "./service.js";
import type { FormKind, FormPayload } from "./types.js";

export interface FormChatTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export const FORM_TOOL_NAMES = ["create_task", "create_lead", "create_project_stage", "record_commitment"] as const;

const KIND_BY_TOOL: Record<(typeof FORM_TOOL_NAMES)[number], FormKind> = {
  create_task: "task",
  create_lead: "lead",
  create_project_stage: "stage",
  record_commitment: "commitment",
};

const COMMON =
  "הכלי הזה לא יוצר דבר ב-Monday — הוא פותח למשתמש בשיחה טופס ממולא-מראש עם מה שכבר נאמר, והמשתמש משלים, עורך ולוחץ 'צור'. " +
  "אל תשאל שאלות על שדות חסרים ואל תחכה לפרטים — קרא לכלי מיד עם מה שיש (גם בלי כלום). אחרי הקריאה ענה במשפט אחד לכל היותר, " +
  "ואסור לומר שנוצר/נשמר/נפתח פריט — זה קורה רק אחרי שהמשתמש שולח את הטופס.";

const STR = (description: string) => ({ type: "string", description });

const DEFS: Record<(typeof FORM_TOOL_NAMES)[number], { description: string; properties: Record<string, unknown> }> = {
  create_task: {
    description:
      "פותח טופס ליצירת משימה חדשה (כללית / מקושרת לפרויקט / תחת שלב). לבקשות 'תפתח/תוסיף/תיצור משימה...'. " +
      COMMON +
      " מלא taskName רק אם המשתמש אמר מה המשימה — לעולם לא ערך מומצא. 'תחת' פרויקט/שלב = taskKind='stage'; 'לקשר לפרויקט' = taskKind='project'; אם לא ברור — השמט taskKind והמשתמש יבחר בטופס.",
    properties: {
      taskName: STR("תוכן המשימה כפי שהמשתמש תיאר. השמט אם לא נאמר."),
      project: STR("שם הפרויקט, אם נאמר."),
      taskKind: { type: "string", enum: ["project", "stage"], description: "רק אם ברור מהניסוח: 'project' = קישור לפרויקט, 'stage' = תחת שלב." },
      stage: STR("שם/מספר השלב, אם נאמר."),
      assignee: STR("שם העובד/ת שיבצע/תבצע, אם נאמר."),
      dueDate: STR("תאריך יעד YYYY-MM-DD, אם נאמר."),
      priority: STR("תעדוף, אם נאמר."),
    },
  },
  create_lead: {
    description:
      "פותח טופס ליצירת ליד חדש (לקוח פוטנציאלי). לבקשות 'תפתח ליד...', 'יש לי ליד חדש...'. " +
      COMMON +
      " מלא רק פרטים שהמשתמש אמר. שם של עמותה/קהילה/מוסד — institutionName; שם של אדם — contactName.",
    properties: {
      contactName: STR("שם איש הקשר (אדם)."),
      phone: STR("מספר טלפון."),
      projectName: STR("שם הפרויקט / הליד."),
      projectType: STR("סוג הפרויקט, כפי שנאמר."),
      email: STR("כתובת מייל."),
      whatsapp: STR("מספר ווצאפ."),
      institutionName: STR("שם עמותה/קהילה/מוסד."),
      source: STR("מקור הגעה."),
      referredBy: STR("מפנה הליד."),
      assignee: STR("אחראי/ת, אם נאמר."),
    },
  },
  create_project_stage: {
    description:
      "פותח טופס ליצירת שלב חדש (לא משימה!) בפרויקט. רק כשהמשתמש ביקש במפורש 'שלב' חדש. " + COMMON,
    properties: {
      project: STR("שם הפרויקט, אם נאמר."),
      name: STR("שם השלב, אם נאמר."),
    },
  },
  record_commitment: {
    description:
      "פותח טופס לרישום התחייבות שהעובד נתן לצד שלישי אמיתי (לקוח / יועץ / גורם חוץ): 'הבטחתי ל...', 'התחייבתי לשלוח עד...'. " +
      COMMON +
      " זו רשומה פנימית ביומן ההתחייבויות (לא Monday ולא הודעה לאף אחד). toWhom חייב להיות מישהו אחר מהמשתמש.",
    properties: {
      toWhom: STR("למי הובטח — לא המשתמש עצמו."),
      what: STR("מה הובטח."),
      dueDate: STR("תאריך יעד YYYY-MM-DD, אם נאמר."),
      project: STR("שם הפרויקט, אם רלוונטי."),
    },
  },
};

export interface FormToolsContext {
  user: IdentifiedUser;
  sessionId: string | null;
  /** clientMessageId — מזהה הטופס נגזר ממנו, כך ש-retry/fallback של אותה הודעה לא פותח טופס שני */
  seed?: string;
  /** קובע כמה טפסים כבר נפתחו בסבב הזה (טופס אחד לכל הודעה) */
  state: { form: FormPayload | null };
}

export function buildFormTools(ctx: FormToolsContext): FormChatTool[] {
  return FORM_TOOL_NAMES.map((name) => ({
    name,
    description: DEFS[name].description,
    input_schema: { type: "object", properties: DEFS[name].properties, required: [] },
    run: async (input) => {
      const kind = KIND_BY_TOOL[name];
      if (ctx.state.form && ctx.state.form.kind !== kind) {
        return { ok: false, error: "כבר נפתח טופס בהודעה הזו — טופס אחד בכל פעם. סיים עם הטופס שנפתח והמשתמש יבקש את השני אחר כך." };
      }
      try {
        const form = openForm(ctx.user, kind, input, { sessionId: ctx.sessionId, seed: ctx.seed });
        ctx.state.form = form;
        return {
          ok: true,
          formOpened: true,
          kind,
          message: "הטופס הוצג למשתמש בשיחה. לא נוצר שום פריט עדיין. סיים במשפט קצר אחד שמזמין למלא ולאשר.",
        };
      } catch (err) {
        if (err instanceof FormError) return { ok: false, error: err.message };
        throw err;
      }
    },
  }));
}
