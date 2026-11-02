/**
 * כלי הצ'אט של מדידת הזמן (Web בלבד, פילוט). נבנים פר-קריאת runOpsChat — סגורים על המשתמש המזוהה, על
 * messageSeed של ההודעה (idempotency) ועל ההודעה האחרונה של העובד (בדיקת אישור החלפה בקוד).
 *
 * התשובה של כל כלי היא טקסט מוכן ב-`message`; chat.ts מגיש אותו מילה במילה (כמו כלי הנוכחות) כדי
 * שהמודל לא ינסח "הפעלתי טיימר" בלי שהופעל, ולא יחשב משכי זמן בעצמו.
 */

import { DateTime } from "luxon";
import type { IdentifiedUser } from "../identity/index.js";
import {
  confirmSwitch,
  getTimeReport,
  getTimerStatus,
  resumeTimer,
  startTimer,
  stopTimer,
  type ReportRange,
  type ReportScope,
  type TimerResult,
  type TimerTaskRef,
} from "./taskTimer.js";

/** אותה צורה כמו ToolDef הפנימי ב-chat.ts (לא מיוצא משם). */
export interface TimerToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface TimerToolsDeps {
  now: DateTime;
  /** מזהה יציב להודעה הנוכחית (attendanceEngine.buildMessageIdempotencySeed) — retry לא יוצר מקטע שני. */
  messageSeed: string;
  /** ההודעה האחרונה של העובד — לבדיקת אישור מפורש להחלפה (בקוד, לא ע"י המודל). */
  latestUserMessage: string;
  /** מאמת שהמשימה פתוחה ושייכת לעובד (מתוך רשימת המשימות שלו) ומחזיר שם/פרויקט מהמקור — לא מהמודל. */
  resolveTask: (itemId: string) => Promise<TimerTaskRef | null>;
  /** נקרא עם הטקסט המוכן של כל כלי טיימר (להגשה מילה במילה) + מסמן שבסבב רץ כלי טיימר. */
  onResult: (toolName: string, result: TimerResult) => void;
}

const EMPTY = { type: "object", properties: {} } as const;

export function buildTimerTools(user: IdentifiedUser, deps: TimerToolsDeps): TimerToolDef[] {
  const wrap = (toolName: string, r: TimerResult): TimerResult => {
    deps.onResult(toolName, r);
    return r;
  };

  return [
    {
      name: "timer_start",
      description:
        "מפעיל טיימר למשימה — רק כשהעובד *מצהיר שהוא מתחיל או ממשיך לעבוד עליה עכשיו* ('מתחיל לעבוד על X', 'אני עובד על התכניות של Y', 'עוברים ל-Z'). " +
        "זה *לא* לשאלות וצפייה: 'מה עם X?', 'תראה לי את X', 'מה הסטטוס של X', 'מה עליי היום' — אלה לא התחלת עבודה, ואסור להפעיל טיימר בגללן. " +
        "קודם זהה את המשימה עם find_task ואז העבר את itemId המדויק. אם כבר פועל טיימר על משימה אחרת — הכלי לא מחליף, " +
        "אלא מחזיר שאלה (needsConfirmation) שחייבת להישאל את העובד כלשונה; החלפה מתבצעת רק ב-timer_confirm_switch אחרי שהעובד אישר. " +
        "הצג את ה-message שחוזר *בדיוק* כמו שהוא. לא משנה סטטוס ב-Monday.",
      input_schema: {
        type: "object",
        properties: { itemId: { type: "string", description: "itemId מדויק מ-find_task / get_today_tasks" } },
        required: ["itemId"],
      },
      run: async (input) => {
        const itemId = String(input.itemId ?? "");
        if (!/^\d+$/.test(itemId)) return wrap("timer_start", { ok: false, message: "מזהה משימה לא תקין — זהה את המשימה עם find_task." });
        const task = await deps.resolveTask(itemId);
        if (!task) return wrap("timer_start", { ok: false, message: "לא מצאתי את המשימה ברשימת המשימות הפתוחות שלך — זהה אותה עם find_task." });
        return wrap("timer_start", startTimer(user, task, deps.now, deps.messageSeed));
      },
    },
    {
      name: "timer_confirm_switch",
      description:
        "מבצע החלפת טיימר שהוצעה קודם (timer_start החזיר needsConfirmation) — קרא לו *רק* כשהעובד ענה בהודעה הנוכחית אישור מפורש " +
        "('כן', 'תחליף', 'בטח') לשאלה 'האם לעצור ולהתחיל טיימר למשימה החדשה'. אם הוא ענה 'לא' / התעלם / שאל משהו אחר — אל תקרא לו. " +
        "האישור נבדק גם בקוד. הצג את ה-message בדיוק.",
      input_schema: EMPTY as unknown as Record<string, unknown>,
      run: async () => wrap("timer_confirm_switch", confirmSwitch(user, deps.latestUserMessage, deps.now, deps.messageSeed)),
    },
    {
      name: "timer_stop",
      description:
        "עוצר את הטיימר הפעיל. 'עצור את הטיימר', 'עצור', 'הפסק למדוד', וגם כשהעובד מאשר לשאלת התזכורת 'האם לעצור אותו?'. " +
        "'סיימתי את המשימה' — סמן בוצע עם mark_done (הוא עוצר את הטיימר אוטומטית); אל תקרא ל-timer_stop בנוסף. " +
        "'אני יוצא להפסקה' / 'סיימתי להיום' — כלי הנוכחות (attendance_*), לא זה: הפסקה מוציאה את הזמן מהספירה לבד, וסגירת יום עוצרת את הטיימר לבד. " +
        "הצג את ה-message בדיוק.",
      input_schema: EMPTY as unknown as Record<string, unknown>,
      run: async () => wrap("timer_stop", stopTimer(user, deps.now, "stopped", deps.messageSeed)),
    },
    {
      name: "timer_resume",
      description:
        "מחזיר את הטיימר למשימה האחרונה שנעצרה היום ('תחזור למשימה הקודמת', 'אני ממשיך לעבוד על זה'). " +
        "חזרה מהפסקה לא דורשת אותו — הטיימר ממשיך מעצמו כשהעובד מדווח שחזר (attendance_break_end). הצג את ה-message בדיוק.",
      input_schema: EMPTY as unknown as Record<string, unknown>,
      run: async () => wrap("timer_resume", resumeTimer(user, deps.now, deps.messageSeed)),
    },
    {
      name: "timer_status",
      description: "'על איזו משימה אני עובד עכשיו?', 'יש לי טיימר פעיל?'. קריאה בלבד. הצג את ה-message בדיוק.",
      input_schema: EMPTY as unknown as Record<string, unknown>,
      run: async () => wrap("timer_status", getTimerStatus(user, deps.now)),
    },
    {
      name: "timer_report",
      description:
        "כמה זמן עבד העובד, לפי מדידת הטיימרים בפועל (נטו, בלי הפסקות): scope=today ('כמה זמן עבדתי היום על משימות'), " +
        "scope=project + query=שם הפרויקט ('כמה זמן עבדתי על פרויקט X'), scope=task + query=שם המשימה ('כמה זמן השקעתי במשימה Y'). " +
        "range (לפרויקט/משימה): today | week | month | all (ברירת מחדל all). זה *לא* שעות הנוכחות הכוללות (attendance_day_status). " +
        "הצג את ה-message בדיוק; אל תחשב בעצמך.",
      input_schema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["today", "project", "task"] },
          query: { type: "string", description: "שם פרויקט/משימה — חובה ל-project ול-task" },
          range: { type: "string", enum: ["today", "week", "month", "all"] },
        },
        required: ["scope"],
      },
      run: async (input) =>
        wrap(
          "timer_report",
          getTimeReport(
            user,
            deps.now,
            String(input.scope ?? "today") as ReportScope,
            input.query ? String(input.query) : undefined,
            input.range ? (String(input.range) as ReportRange) : undefined,
          ),
        ),
    },
  ];
}
