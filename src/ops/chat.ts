/**
 * צ'אט תפעולי לעובד (שלב 3) — "בסגנון שיחה".
 *
 * העובד כותב בשפה חופשית ("בוקר טוב", "סיימתי את התכניות של בלומינג", "מה הבא?"), והעוזר:
 *  1. בבוקר — מציג את המשימות של היום.
 *  2. כשמדווחים ביצוע/התקדמות — מזהה את המשימה ומעדכן ב-Monday.
 *  3. שואל מה הבא בתור.
 *
 * מבוסס על אותם אבני בניין שכבר קיימות: getEmployeeDashboard (מה המשימות),
 * fetchUserOpsTasks (רשימה מלאה לזיהוי), updateTask (הכתיבה — עם בדיקת הרשאה ובעלות).
 * הכל ממודר לעובד המחובר בלבד.
 */

import { DateTime } from "luxon";
import { env } from "../config/env.js";
import { userCan, type IdentifiedUser } from "../identity/index.js";
import {
  fetchUserOpsTasks,
  getProjectNextAction,
  type OpsTask,
} from "../integrations/monday/opsRead.js";
import {
  addCommitment,
  closeCommitment,
  listUserCommitments,
} from "../db/repositories/commitments.js";
import { logger } from "../utils/logger.js";
import { runRoutedAgent } from "../ai/routedAgent.js";
import type { NormTool, NormToolCall } from "../ai/providers/types.js";
import { addUpdateToItem, reassignItem, updateTask } from "./actions.js";
import {
  replyAwaitManager,
  replyBlocked,
  replyDefer,
  replyDone,
  replyNotRelevant,
  replyProgress,
  replyWaiting,
  type LoopContext,
} from "./loopReply.js";
import { searchLeadsAndDeals } from "../integrations/monday/crmRead.js";
import { runControlScan } from "./controlScan.js";
import { runCrmScan } from "./crmScan.js";
import { buildDashboardViews, type DashboardTask } from "./dashboard.js";
import { getOfficeState } from "./officeState.js";
import { getOversightReport } from "./oversight.js";

const MAX_TURNS = 7;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OpsChatResult {
  reply: string;
  /** תיאור קצר של כל עדכון שבוצע ב-Monday בסבב הזה — לרענון הרשימה ולתצוגה */
  actions: string[];
}

function systemPrompt(user: IdentifiedUser, about?: LoopContext): string {
  const now = DateTime.now().setZone(env.TIMEZONE);
  return [
    `אתה העוזר התפעולי של ${user.name} במשרד האדריכלים "גוטליב אדריכלים". תפקיד המשתמש: ${user.roleDescription}`,
    `היום ${now.toFormat("EEEE, dd/MM/yyyy")}, השעה ${now.toFormat("HH:mm")} (${env.TIMEZONE}).`,
    "דבר עברית, קצר, חם ולעניין. אתה בצד של העובד — עוזר לו לנהל את היום, לא בודק אותו.",
    ...(about
      ? [
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          `🔔 מנוע הבקרה פנה לעובד ביוזמתו על משימה ספציפית: "${about.taskName ?? about.itemId}".`,
          "ההודעה של העובד עכשיו היא התשובה שלו לפנייה הזו. המשימה כבר ידועה לך במלואה —",
          "**אסור** לקרוא get_today_tasks או find_task. חובה: לזהות את הכוונה, לקרוא כלי reply_* אחד, ולסיים.",
          "",
          'מיפוי (הצד הימני = הכלי לקרוא):',
          '  "סיימתי" / "הגשתי" / "בוצע" / "גמרתי"            → reply_done',
          '  "עדיין עובד" / "באמצע" / "כמעט" / "מתקדם"        → reply_progress(note)',
          '  "צריך עוד X ימים" / "עד יום ___" / "תן לי ארכה"  → reply_defer(newDate=YYYY-MM-DD, reason)',
          '  "מחכה ללקוח" / "הכדור אצל הלקוח"                 → reply_waiting(on="client", reason)',
          '  "מחכה ליועץ/לספק/לקונסטרוקטור/למהנדס"           → reply_waiting(on="consultant", reason)',
          '  "מחכה שמוטי/שהמנהל יחליט" / "צריך אישור מלמעלה"  → reply_await_manager(question)',
          '  "תקוע כי…" / "חסום כי…" / "לא יכול להתקדם כי…"    → reply_blocked(blocker)',
          '  "לא רלוונטי" / "בוטל" / "כבר לא צריך"            → reply_not_relevant(reason)',
          "",
          "אם העובד נתן גם מסגרת זמן קונקרטית וגם למי הוא מחכה ('צריך יומיים, מחכה לקונסטרוקטור') —",
          "reply_defer מנצח (המסגרת זמן היא הדבר המעשי), והסיבה ('מחכה לקונסטרוקטור') נכנסת ל-reason.",
          "אחרי שהכלי חזר — אמור לעובד במשפט אחד את ה-message ואת ה-tracking שקיבלת. אל תקרא עוד כלים.",
          "רק אם ההודעה ברור שאינה תשובה לפנייה (שאלה כללית, נושא אחר) — התעלם מהבלוק הזה וטפל רגיל.",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ]
      : []),
    "",
    "איך לעבוד:",
    "• כשהעובד אומר 'בוקר טוב' / 'מה יש לי' / 'מה על הפרק' — קרא get_today_tasks. הצג למשתמש את השדה 'briefing' שחוזר משם כמעט כמו שהוא — מותר להוסיף ברכה קצרה בהתאם לשעה ולסיים ב'על מה מתחילים?', אבל אל תשנה את רשימת הפרויקטים, את שורות 'עכשיו:' ואת סימוני האיחור/הקריטי. אל תוסיף 'דורש תשומת לב' / 'מחכים ממני' אלא אם ביקשו.",
    "• כשהעובד מדווח שביצע / התקדם / שינה משהו — זהה את המשימה עם find_task (לפי מה שהוא תיאר). אם יש כמה התאמות — הצג אותן ושאל איזו. אם אין — אמור זאת ובקש תיאור מדויק יותר.",
    "• אחרי שזיהית — עדכן ב-Monday: mark_done כשסיים, set_status ל'בעבודה' כשהתחיל, add_note לעדכון ביניים. אשר בקצרה מה עדכנת ואז שאל: 'מה הבא שאתה עובד עליו?'",
    "• 'תקוע' / 'חסום' / 'מחכה ל...' — קרא report_blocker עם תיאור החסם.",
    "• 'תכתוב בעדכונים של הליד/המשימה/הפרויקט/העסקה X ש…' / 'תוסיף הערה ל…' — זהה את הפריט (find_task / find_lead_or_deal / project_status), קח את ה-itemId, וקרא add_update. עובד על כל סוג פריט ב-Monday, לא רק משימות.",
    "• 'הבטחתי ללקוח...' / 'אמרתי ש...' / 'התחייבתי ל...' — קרא record_commitment. 'שלחתי ללקוח' / 'קיימתי' על התחייבות קיימת — close_commitment. 'מה הבטחתי?' — list_my_commitments.",
    ...(userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage")
      ? [
          "• 'תעביר את האחריות על X ל...' / 'תשייך את הליד/הפרויקט/המשימה ל...' — זהה את הפריט, קח itemId, וקרא reassign_item. אשר בקצרה למי הועבר. אם השם לא חד-משמעי — שאל לפני.",
        ]
      : []),
    "",
    "כללים:",
    "• לעולם אל תעדכן ב-Monday בלי שהעובד אמר מפורשות שהוא ביצע או שינה משהו. שאלה או בקשת מידע אינה דיווח.",
    "• אל תמציא משימות או שמות. השתמש רק במה שהכלים מחזירים.",
    "• אם פעולה נכשלה — אמור מה קרה, אל תעמיד פנים שהצליחה.",
    ...(userCan(user, "view:all_work")
      ? [
          "",
          "יש לך גם ראייה על כל המשרד. כשמוטי שואל 'מה תקוע?', 'מה דורש אותי?', 'מה קורה אצל דוב?', 'מה מצב פרויקט X?', 'מה מצב המכירות/הגבייה?', 'איזה פרויקטים בסיכון?' — השתמש בכלי הבקרה (office_overview / person_status / project_status / list_findings / sales_and_collection). כשמוטי מבקש למצוא ליד או עסקה ספציפית ('גש לליד X', 'מה מצב העסקה של Y') — קרא find_lead_or_deal (מחפש בכל הסטטוסים). ענה תמציתי עם המספרים והשמות, והצע צעד הבא כשברור.",
        ]
      : []),
  ].join("\n");
}

function fmtTask(t: DashboardTask): string {
  const where = t.stageName ? `${t.context} › ${t.stageName}` : t.context;
  const bits = [where];
  if (t.dueDate) bits.push(t.flags.overdue ? `באיחור ${t.flags.daysOverdue} ימים` : t.dueDate);
  if (t.status) bits.push(t.status);
  if (t.priority?.includes("קריטי")) bits.push("קריטי");
  if (t.flags.blocking.length) bits.push(`חוסם ${t.flags.blocking.length}`);
  return `[${t.source}:${t.itemId}] ${t.name} — ${bits.join(" · ")}`;
}

/**
 * תדריך "היום שלי" מקובץ לפי פרויקט, עם שורת "עכשיו:" לכל פרויקט (הפעולה הבאה המחושבת).
 * נבנה בשרת כדי שהתצוגה תהיה עקבית — הצ'אט רק מגיש אותו.
 */
async function buildTodayBriefing(myDay: DashboardTask[], user: IdentifiedUser): Promise<string> {
  if (myDay.length === 0) return "אין משימות לטיפול היום 👌";

  // קיבוץ: פרויקט מקושר (projectId) → קבוצה; משימות משרד כלליות → דלי נפרד
  const groups = new Map<string, { label: string; projectId?: string; tasks: DashboardTask[] }>();
  const officeTasks: DashboardTask[] = [];
  for (const t of myDay) {
    const hasProject = t.context && t.context !== "משימת משרד" && t.context !== "פרויקט לא מקושר";
    if (t.projectId) {
      const g = groups.get(t.projectId) ?? { label: t.context, projectId: t.projectId, tasks: [] };
      g.tasks.push(t);
      groups.set(t.projectId, g);
    } else if (hasProject) {
      const key = "name:" + t.context;
      const g = groups.get(key) ?? { label: t.context, tasks: [] };
      g.tasks.push(t);
      groups.set(key, g);
    } else {
      officeTasks.push(t);
    }
  }

  const flagStr = (t: DashboardTask): string => {
    const bits: string[] = [];
    if (t.flags.critical) bits.push("🔴 קריטי");
    if (t.flags.overdue) bits.push(`באיחור ${t.flags.daysOverdue} ימים`);
    else if (t.flags.dueToday) bits.push("להיום");
    return bits.join(" · ");
  };

  const myTaskIds = new Set(myDay.map((t) => t.itemId));
  const lines: string[] = [`היום על הפרק — ${myDay.length} משימות:`];

  // "הפעולה הבאה" לכל הפרויקטים במקביל — אחרת "בוקר טוב" של מנהל פרויקט עם כמה פרויקטים איטי מדי.
  const groupList = [...groups.values()];
  const nextActions = await Promise.all(
    groupList.map((g) => (g.projectId ? getProjectNextAction(g.projectId).catch(() => null) : Promise.resolve(null))),
  );

  for (let i = 0; i < groupList.length; i++) {
    const g = groupList[i]!;
    // המשימה הבולטת בקבוצה קובעת את סימון הדגל של הפרויקט
    const lead = [...g.tasks].sort(
      (a, b) => Number(b.flags.critical) - Number(a.flags.critical) || b.flags.daysOverdue - a.flags.daysOverdue,
    )[0]!;
    const fl = flagStr(lead);
    lines.push("", `📁 ${g.label}${fl ? ` — ${fl}` : ""}`);

    const na = nextActions[i];
    if (na) {
      let suffix = "";
      if (!na.assignees) suffix = " (עדיין לא משויך)";
      else if (!na.assignees.includes(user.name)) suffix = ` (אצל ${na.assignees})`;
      else if (myTaskIds.has(na.taskId)) suffix = " (זו המשימה שלך)";
      lines.push(`   עכשיו: ${na.taskName} · ${na.stageName}${suffix}`);
    } else {
      // אין פרויקט מקושר / לא הצלחנו לחשב — נופלים למשימה של העובד עצמו
      lines.push(`   עכשיו: ${g.tasks[0]!.name}${g.tasks[0]!.stageName ? ` · ${g.tasks[0]!.stageName}` : ""}`);
    }
    // אם לעובד יש עוד משימות באותו פרויקט מעבר לצעד הנוכחי — נזכיר בקצרה
    const extra = g.tasks.filter((t) => t.name !== (na?.taskName ?? g.tasks[0]!.name));
    if (extra.length) lines.push(`   גם שלך כאן: ${extra.map((t) => t.name).join(" · ")}`);
  }

  if (officeTasks.length) {
    lines.push("", "🗂️ משימות משרד:");
    for (const t of officeTasks) {
      const fl = flagStr(t);
      lines.push(`   • ${t.name}${fl ? ` — ${fl}` : ""}`);
    }
  }

  return lines.join("\n");
}

function matchScore(task: OpsTask, q: string): number {
  const hay = `${task.name} ${task.context} ${task.stageName ?? ""}`.toLowerCase();
  const needle = q.toLowerCase().trim();
  if (!needle) return 0;
  if (hay.includes(needle)) return 100;
  const words = needle.split(/\s+/).filter((w) => w.length > 1);
  return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
}

interface ToolDef {
  name: string;
  description: string;
  /** אובייקט JSON Schema — מתורגם לפורמט של כל provider בשכבת ה-providers */
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface OpsChatOptions {
  /** ההודעה היא תשובה לפנייה יזומה של הבקרה על משימה ספציפית — מפעיל את כלי סגירת הלולאה. */
  about?: LoopContext;
}

export async function runOpsChat(
  user: IdentifiedUser,
  history: ChatMessage[],
  opts: OpsChatOptions = {},
): Promise<OpsChatResult> {
  if (!user.mondayUserId) {
    return { reply: "אין לך חשבון Monday מקושר, אז אין לי גישה למשימות שלך. פנה/י ליוכי.", actions: [] };
  }

  const now = DateTime.now().setZone(env.TIMEZONE);
  let tasks = await fetchUserOpsTasks(user.mondayUserId);
  const actions: string[] = [];
  // התדריך של "בוקר טוב" מוגש מילה במילה — מודלים נוטים לקצר/לנסח מחדש, וכאן חשוב שהמבנה
  // (פרויקט → 'עכשיו:') יישאר בדיוק כמו שבנינו אותו.
  let capturedBriefing: string | null = null;

  const refresh = async () => {
    tasks = await fetchUserOpsTasks(user.mondayUserId!);
  };

  const findTask = (itemId: string): OpsTask | undefined => tasks.find((t) => t.itemId === itemId);

  const tools: ToolDef[] = [
    {
      name: "get_today_tasks",
      description:
        "מחזיר את המשימות של המשתמש להיום: מה לטפל בו היום, מה דורש תשומת לב, ומה אחרים מחכים לו. לכל פרויקט שמופיע במשימות של היום מצורף גם 'הצעד הנוכחי בפרויקט' — המשימה/תת-המשימה שצריך לעשות עכשיו באותו פרויקט לפי סדר השלבים.",
      input_schema: { type: "object", properties: {} },
      run: async () => {
        const v = buildDashboardViews(tasks, now);
        const briefing = await buildTodayBriefing(v.myDay, user);
        capturedBriefing = briefing;
        return {
          counts: {
            today: v.myDay.length,
            needsAttention: v.needsAttention.length,
            waitingOnMe: v.waitingOnMe.length,
            totalOpen: tasks.length,
          },
          briefing,
          needsAttention: v.needsAttention.slice(0, 8).map(fmtTask),
          waitingOnMe: v.waitingOnMe.slice(0, 8).map(fmtTask),
        };
      },
    },
    {
      name: "find_task",
      description: "מחפש משימה פתוחה של המשתמש לפי תיאור חופשי (שם משימה / פרויקט / שלב). מחזיר עד 5 התאמות עם המזהה. השתמש בזה כדי לזהות על איזו משימה העובד מדבר לפני עדכון.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "מה שהעובד תיאר, למשל 'התכניות של בלומינג'" } },
        required: ["query"],
      },
      run: async (input) => {
        const q = String(input.query ?? "");
        const ranked = tasks
          .map((t) => ({ t, score: matchScore(t, q) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        return {
          matches: ranked.map(({ t }) => ({
            itemId: t.itemId,
            source: t.source,
            name: t.name,
            context: t.stageName ? `${t.context} › ${t.stageName}` : t.context,
            status: t.status,
            dueDate: t.dueDate ?? null,
          })),
        };
      },
    },
    {
      name: "mark_done",
      description: "מסמן משימה כבוצעה ב-Monday. השתמש רק אחרי שהעובד אמר מפורשות שסיים אותה.",
      input_schema: {
        type: "object",
        properties: { itemId: { type: "string" }, source: { type: "string", enum: ["general", "project_stage"] } },
        required: ["itemId", "source"],
      },
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, { action: "done", source: input.source as OpsTask["source"], itemId: String(input.itemId) });
        actions.push(`✅ ${t?.name ?? input.itemId} — בוצע`);
        await refresh();
        return r;
      },
    },
    {
      name: "set_status",
      description: "מעדכן סטטוס משימה ב-Monday (למשל 'בעבודה' כשהעובד מתחיל לעבוד עליה).",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          source: { type: "string", enum: ["general", "project_stage"] },
          status: { type: "string", description: "תווית סטטוס, למשל 'בעבודה'" },
        },
        required: ["itemId", "source", "status"],
      },
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, {
          action: "state",
          source: input.source as OpsTask["source"],
          itemId: String(input.itemId),
          label: String(input.status),
        });
        actions.push(`↻ ${t?.name ?? input.itemId} — ${input.status}`);
        await refresh();
        return r;
      },
    },
    {
      name: "add_note",
      description: "מוסיף הערת עדכון למשימה ב-Monday (עדכון ביניים מהעובד).",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          source: { type: "string", enum: ["general", "project_stage"] },
          note: { type: "string" },
        },
        required: ["itemId", "source", "note"],
      },
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, {
          action: "note",
          source: input.source as OpsTask["source"],
          itemId: String(input.itemId),
          note: String(input.note),
        });
        actions.push(`✎ ${t?.name ?? input.itemId} — הערה`);
        return r;
      },
    },
    {
      name: "report_blocker",
      description: "מסמן משימה כתקועה ב-Monday ומוסיף הערה עם תיאור החסם.",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          source: { type: "string", enum: ["general", "project_stage"] },
          note: { type: "string", description: "מה חוסם" },
        },
        required: ["itemId", "source", "note"],
      },
      run: async (input) => {
        const t = findTask(String(input.itemId));
        const r = await updateTask(user, {
          action: "blocker",
          source: input.source as OpsTask["source"],
          itemId: String(input.itemId),
          note: String(input.note),
        });
        actions.push(`🚧 ${t?.name ?? input.itemId} — תקוע`);
        await refresh();
        return r;
      },
    },
    {
      name: "add_update",
      description:
        "מוסיף הערת עדכון (Update) לכל פריט ב-Monday — ליד / משימה / פרויקט / עסקה / גבייה. קבל את itemId מ-find_task / find_lead_or_deal / project_status. לבקשות כמו 'תכתוב בעדכונים של הליד X ש…', 'תוסיף הערה לפרויקט Y'.",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "מזהה הפריט ב-Monday" },
          body: { type: "string", description: "תוכן ההערה" },
          label: { type: "string", description: "שם הפריט, לאישור בלבד" },
        },
        required: ["itemId", "body"],
      },
      run: async (input) => {
        const r = await addUpdateToItem(user, String(input.itemId), String(input.body));
        actions.push(`✎ הערה נוספה${input.label ? `: ${input.label}` : ""}`);
        return r;
      },
    },
    {
      name: "record_commitment",
      description:
        "רושם התחייבות שהעובד נתן — משהו שהובטח ללקוח / ליועץ / לגורם אחר. קרא לזה כשהעובד אומר 'הבטחתי ל...', 'אמרתי ללקוח ש...', 'התחייבתי לשלוח עד...'. נסה למלא תאריך יעד אם נאמר.",
      input_schema: {
        type: "object",
        properties: {
          toWhom: { type: "string", description: "למי הובטח (שם הלקוח/הגורם)" },
          what: { type: "string", description: "מה הובטח" },
          dueDate: { type: "string", description: "תאריך יעד YYYY-MM-DD, אם נאמר" },
          project: { type: "string", description: "שם הפרויקט אם רלוונטי" },
        },
        required: ["toWhom", "what"],
      },
      run: async (input) => {
        const c = addCommitment({
          createdBy: user.key,
          toWhom: String(input.toWhom),
          what: String(input.what),
          dueDate: input.dueDate ? String(input.dueDate) : undefined,
          project: input.project ? String(input.project) : undefined,
        });
        actions.push(`🤝 התחייבות נרשמה: ${c.toWhom} — ${c.what}`);
        return { ok: true, id: c.id, dueDate: c.dueDate };
      },
    },
    {
      name: "list_my_commitments",
      description: "מחזיר את ההתחייבויות הפתוחות של העובד. לשאלות כמו 'מה הבטחתי?', 'מה אני חייב ללקוחות?'.",
      input_schema: { type: "object", properties: {} },
      run: async () => ({
        commitments: listUserCommitments(user.key).map((c) => ({
          id: c.id,
          toWhom: c.toWhom,
          what: c.what,
          dueDate: c.dueDate,
        })),
      }),
    },
    {
      name: "close_commitment",
      description: "סוגר התחייבות — כשהעובד אומר שקיים אותה ('שלחתי ללקוח', 'קיימתי') או שהיא כבר לא רלוונטית. קבל id מ-list_my_commitments.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "number" },
          outcome: { type: "string", enum: ["done", "cancelled"] },
        },
        required: ["id", "outcome"],
      },
      run: async (input) => {
        const ok = closeCommitment(Number(input.id), input.outcome === "cancelled" ? "cancelled" : "done");
        if (ok) actions.push(`🤝 התחייבות ${input.outcome === "cancelled" ? "בוטלה" : "קוימה"}`);
        return { ok };
      },
    },
  ];

  // ---- סגירת הלולאה: תשובה לפנייה יזומה של הבקרה על משימה ידועה ----
  if (opts.about) {
    const c = opts.about;
    const label = c.taskName ?? c.itemId;
    const runLoop = async (
      tag: string,
      fn: () => Promise<{ message: string; tracking: string }>,
    ): Promise<{ message: string; tracking: string }> => {
      const r = await fn();
      actions.push(tag);
      await refresh();
      return r;
    };
    tools.push(
      {
        name: "reply_done",
        description: "העובד דיווח שסיים את המשימה. מסמן בוצע וסוגר את ממצא הבקרה.",
        input_schema: { type: "object", properties: {} },
        run: () => runLoop(`✅ ${label} — בוצע`, () => replyDone(user, c)),
      },
      {
        name: "reply_progress",
        description: "העובד דיווח שהוא עדיין עובד על המשימה / באמצע / כמעט סיים. רושם הערה ונותן לו עוד יום עבודה.",
        input_schema: {
          type: "object",
          properties: { note: { type: "string", description: "מה שהעובד אמר על ההתקדמות" } },
          required: ["note"],
        },
        run: (i) => runLoop(`🔄 ${label} — עדכון התקדמות`, () => replyProgress(user, c, String(i.note))),
      },
      {
        name: "reply_defer",
        description:
          "העובד ביקש דחייה ('צריך עוד יומיים', 'עד יום חמישי', 'תדחה לשבוע הבא'). מעדכן את תאריך היעד ב-Monday, מתעד את בקשת הדחייה, ומשהה את הבקרה עד התאריך החדש.",
        input_schema: {
          type: "object",
          properties: {
            newDate: { type: "string", description: "תאריך היעד החדש, YYYY-MM-DD — חשב לפי התאריך היום שבמערכת" },
            reason: { type: "string", description: "סיבת הדחייה אם נאמרה" },
          },
          required: ["newDate"],
        },
        run: (i) =>
          runLoop(`📅 ${label} — נדחה ל-${String(i.newDate)}`, () =>
            replyDefer(user, c, String(i.newDate), i.reason ? String(i.reason) : undefined),
          ),
      },
      {
        name: "reply_waiting",
        description:
          "העובד דיווח שהוא ממתין לגורם חיצוני: 'מחכה ללקוח' (on=client), 'מחכה ליועץ/לספק/לקונסטרוקטור' (on=consultant), גורם אחר (on=other). מעדכן סטטוס המתנה ומתעד את הסיבה.",
        input_schema: {
          type: "object",
          properties: {
            on: { type: "string", enum: ["client", "consultant", "other"] },
            reason: { type: "string", description: "למה בדיוק מחכים" },
          },
          required: ["on"],
        },
        run: (i) =>
          runLoop(`⏳ ${label} — ממתין (${String(i.on)})`, () =>
            replyWaiting(user, c, i.on as "client" | "consultant" | "other", i.reason ? String(i.reason) : undefined),
          ),
      },
      {
        name: "reply_blocked",
        description: "העובד דיווח שהמשימה תקועה בגלל חסם ('תקוע כי...', 'חסום כי...'). מסמן תקוע ומתעד את החסם.",
        input_schema: {
          type: "object",
          properties: { blocker: { type: "string", description: "מה חוסם" } },
          required: ["blocker"],
        },
        run: (i) => runLoop(`🚧 ${label} — תקוע`, () => replyBlocked(user, c, String(i.blocker))),
      },
      {
        name: "reply_await_manager",
        description:
          "העובד דיווח שהוא ממתין להחלטה של מנהל ('מחכה שמוטי יחליט', 'צריך אישור מלמעלה'). מתעד על המשימה ומעדכן את מוטי שהעובד ממתין להחלטתו.",
        input_schema: {
          type: "object",
          properties: { question: { type: "string", description: "על מה בדיוק מחכים להחלטה" } },
          required: ["question"],
        },
        run: (i) => runLoop(`🧑‍⚖️ ${label} — הועבר למוטי`, () => replyAwaitManager(user, c, String(i.question))),
      },
      {
        name: "reply_not_relevant",
        description: "העובד דיווח שהמשימה כבר לא רלוונטית / בוטלה / לא צריך אותה יותר. מעדכן סטטוס ומתעד וסוגר את הממצא.",
        input_schema: {
          type: "object",
          properties: { reason: { type: "string", description: "למה כבר לא רלוונטי" } },
        },
        run: (i) => runLoop(`🚫 ${label} — לא רלוונטי`, () => replyNotRelevant(user, c, i.reason ? String(i.reason) : undefined)),
      },
    );
  }

  // ---- שינוי אחראי/ת — למי שמנהל משימות/לידים/פרויקטים ----
  if (userCan(user, "task:manage") || userCan(user, "lead:manage") || userCan(user, "project:manage")) {
    tools.push({
      name: "reassign_item",
      description:
        "מחליף את האחראי/ת של פריט ב-Monday — ליד / עסקה / משימה / פרויקט / שלב. קבל את itemId מ-find_task / find_lead_or_deal / project_status. לבקשות כמו 'תעביר את האחריות על הליד X ליוכי', 'תשייך את הפרויקט לדוב'. משנה בפועל את שדה האחראי ומתעד ב-Updates.",
      input_schema: {
        type: "object",
        properties: {
          itemId: { type: "string", description: "מזהה הפריט ב-Monday" },
          person: { type: "string", description: "שם מלא או פרטי של מי שיהיה האחראי/ת החדש/ה" },
          label: { type: "string", description: "שם הפריט, לאישור בלבד" },
        },
        required: ["itemId", "person"],
      },
      run: async (input) => {
        const r = await reassignItem(user, String(input.itemId), String(input.person));
        actions.push(`👤 ${r.message}`);
        return r;
      },
    });
  }

  // ---- כלי בקרה על כל המשרד — רק למי שיש view:all_work (מוטי, יוכי) ----
  if (userCan(user, "view:all_work")) {
    const fmtFinding = (f: { severity: string; headline: string; who: string; detail: string }) =>
      `[${f.severity}] ${f.headline} — ${f.who}${f.detail ? ` · ${f.detail}` : ""}`;

    tools.push(
      {
        name: "office_overview",
        description: "תמונת מצב כללית של כל המשרד: מספרי משימות פתוחות/באיחור/תקועות, פרויקטים בסיכון, וממצאי מכירות וגבייה. לשאלות כמו 'מה המצב הכללי' / 'מה דורש אותי'.",
        input_schema: { type: "object", properties: {} },
        run: async () => {
          const [ctrl, crm, over] = await Promise.all([runControlScan(), runCrmScan(), getOversightReport(user)]);
          return {
            tasks: { open: over.totals.openTasks, overdue: over.totals.overdue, stuck: over.totals.stuck },
            projectsFlagged: over.totals.projectsFlagged,
            controlFindings: { critical: ctrl.counts.critical, high: ctrl.counts.high, normal: ctrl.counts.normal },
            crmFindings: { high: crm.counts.high, normal: crm.counts.normal },
            topUrgent: [...ctrl.forManager, ...crm.forManager].slice(0, 10).map(fmtFinding),
            decisionsWaiting: crm.decisions.map((d) => `${d.name} — ${d.detail}`),
          };
        },
      },
      {
        name: "person_status",
        description: "מצב העבודה של איש צוות מסוים: כמה משימות פתוחות/באיחור/תקועות יש לו, מה הכי באיחור, ואיזה פרויקטים בסיכון קשורים אליו. לשאלות כמו 'מה קורה אצל דוב'.",
        input_schema: {
          type: "object",
          properties: { name: { type: "string", description: "שם איש הצוות" } },
          required: ["name"],
        },
        run: async (input) => {
          const q = String(input.name ?? "").trim();
          const [over, ctrl] = await Promise.all([getOversightReport(user), runControlScan()]);
          const p = over.people.find((x) => x.name.includes(q) || q.includes(x.name.split(" ")[0]!));
          if (!p) return { error: `לא מצאתי איש צוות בשם "${q}". אפשרויות: ${over.people.map((x) => x.name).join(", ")}` };
          return {
            name: p.name,
            counts: p.counts,
            worst: p.worst,
            findings: ctrl.findings.filter((f) => f.who.includes(p.name)).map(fmtFinding),
          };
        },
      },
      {
        name: "project_status",
        description: "מצב פרויקט מסוים: סטטוס, אחראי, תאריך מסירה, הפעולה הנוכחית, וכל דגל בקרה שקשור אליו. לשאלות כמו 'מה מצב פרויקט בלומינג'.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "שם הפרויקט או חלק ממנו" } },
          required: ["query"],
        },
        run: async (input) => {
          const q = String(input.query ?? "").trim().toLowerCase();
          const [office, ctrl] = await Promise.all([getOfficeState(), runControlScan()]);
          const matches = office.projects.filter((p) => p.name.toLowerCase().includes(q));
          if (matches.length === 0) return { error: `לא מצאתי פרויקט שמתאים ל"${q}".` };
          if (matches.length > 3) return { hint: "יותר מדי התאמות", names: matches.map((p) => p.name).slice(0, 10) };
          const out = [];
          for (const p of matches) {
            const na = await getProjectNextAction(p.itemId).catch(() => null);
            out.push({
              itemId: p.itemId,
              name: p.name,
              status: p.status || "לא הוגדר",
              owner: p.owner || "בלי אחראי",
              deliveryDate: p.deliveryDate ?? null,
              nextAction: na ? `${na.taskName} · ${na.stageName}${na.assignees ? ` (${na.assignees})` : " (לא משויך)"}` : "אין משימה פתוחה",
              findings: ctrl.findings.filter((f) => f.project === p.name).map(fmtFinding),
            });
          }
          return { projects: out };
        },
      },
      {
        name: "list_findings",
        description: "רשימת ממצאי הבקרה, אפשר לסנן. area: tasks (משימות) / projects (פרויקטים) / sales (מכירות ולידים) / collection (גבייה). severity: critical / high / normal. לשאלות כמו 'מה תקוע', 'מה דחוף', 'איזה פרויקטים בסיכון'.",
        input_schema: {
          type: "object",
          properties: {
            area: { type: "string", enum: ["tasks", "projects", "sales", "collection"] },
            severity: { type: "string", enum: ["critical", "high", "normal"] },
          },
        },
        run: async (input) => {
          const [ctrl, crm] = await Promise.all([runControlScan(), runCrmScan()]);
          let list = [...ctrl.findings, ...crm.findings];
          const area = input.area as string | undefined;
          if (area === "projects") list = list.filter((f) => f.kind === "project_stuck" || f.kind === "delivery_overdue");
          else if (area === "sales") list = list.filter((f) => f.project === "מכירות" || f.project === "לידים");
          else if (area === "collection") list = list.filter((f) => f.project === "גבייה");
          else if (area === "tasks")
            list = list.filter(
              (f) => !["מכירות", "לידים", "גבייה"].includes(f.project ?? "") && f.kind !== "project_stuck" && f.kind !== "delivery_overdue",
            );
          if (input.severity) list = list.filter((f) => f.severity === input.severity);
          return { count: list.length, findings: list.slice(0, 25).map(fmtFinding) };
        },
      },
      {
        name: "sales_and_collection",
        description: "מצב מלא של המכירות והגבייה: עסקאות בלי פולו-אפ, הצעות מחיר תלויות, החלטות שמחכות, ותשלומים באיחור עם סכומים. לשאלות כמו 'מה מצב המכירות', 'מה מצב הגבייה'.",
        input_schema: { type: "object", properties: {} },
        run: async () => {
          const crm = await runCrmScan();
          return {
            decisionsWaiting: crm.decisions.map((d) => `${d.name} — ${d.detail}`),
            sales: crm.findings.filter((f) => f.project === "מכירות" || f.project === "לידים").map(fmtFinding),
            collection: crm.findings.filter((f) => f.project === "גבייה").map(fmtFinding),
            paymentsDueToday: crm.paymentsDueToday.map((p) => `${p.label} ${p.amount}`),
          };
        },
      },
      {
        name: "find_lead_or_deal",
        description:
          "מחפש ליד או עסקה ספציפית לפי שם, בכל הסטטוסים (כולל סגורים ומוקפאים) — חיפוש ישיר בבורדי הלידים והעסקאות. השתמש בזה כשמוטי מבקש 'גש לליד X', 'מה מצב העסקה של Y', 'תמצא את הליד של Z'. מחזיר סטטוס, אחראי, תאריך תזכורת ותאריך יצירה.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "שם הליד/העסקה או חלק ממנו" } },
          required: ["query"],
        },
        run: async (input) => {
          const matches = await searchLeadsAndDeals(String(input.query ?? ""));
          if (matches.length === 0) {
            return { found: false, note: "לא נמצא ליד/עסקה עם השם הזה בשני הבורדים." };
          }
          return {
            found: true,
            matches: matches.map((m) => ({
              board: m.board,
              itemId: m.itemId,
              name: m.name,
              status: m.status || "לא הוגדר",
              owner: m.owner || "בלי אחראי",
              reminderDate: m.reminderDate ?? null,
              createdDate: m.createdDate ?? null,
              extra: m.extra ?? null,
              url: m.url,
            })),
          };
        },
      },
    );
  }

  const normTools: NormTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));

  // ── מפרט הלולאה לכל ניסיון. הלולאה עצמה ב-agentLoop; הניתוב + fallback ב-runRoutedAgent.
  //    כאן רק: הרצת הכלים (עם מעקב כתיבות ל-sideEffect) והגשת תדריך הבוקר מילה-במילה.
  const buildLoop = () => {
    capturedBriefing = null; // איפוס לפני כל ניסיון — כדי שה-fallback ל-SMART יאסוף תדריך מחדש
    return {
      system: systemPrompt(user, opts.about),
      maxTokens: 1024,
      maxTurns: MAX_TURNS,
      messages: history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      tools: normTools,
      executeToolCall: async (call: NormToolCall) => {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) return { content: `שגיאה: כלי לא ידוע ${call.name}`, sideEffect: false };
        try {
          const before = actions.length; // כלי כתיבה מוסיף ל-actions — כך יודעים אם הייתה תופעת לוואי
          const out = await tool.run((call.input ?? {}) as Record<string, unknown>);
          return { content: JSON.stringify(out), sideEffect: actions.length > before };
        } catch (err) {
          logger.warn({ err, tool: call.name, user: user.key }, "כלי צ'אט תפעולי נכשל");
          return { content: `שגיאה: ${(err as Error).message}`, sideEffect: false };
        }
      },
      finalizeText: (modelText: string) => {
        // אם בסבב הזה נשלף תדריך היום ולא בוצעו עדכונים — מגישים אותו כפי שהוא, עם ברכה קצרה,
        // במקום הניסוח החופשי של המודל (שנוטה לאבד את מבנה 'עכשיו:' לכל פרויקט).
        // לא רלוונטי בתשובה לפנייה יזומה — שם רוצים את התשובה של הכלי.
        if (capturedBriefing && actions.length === 0 && !opts.about) {
          const hour = now.hour;
          const greet = hour < 12 ? "בוקר טוב" : hour < 17 ? "צהריים טובים" : "ערב טוב";
          return `${greet} ${user.name} ☀️\n\n${capturedBriefing}\n\nעל מה מתחילים?`;
        }
        return modelText || null;
      },
    };
  };

  const routed = await runRoutedAgent({
    useCase: "ops_chat",
    latestMessage: history[history.length - 1]?.content ?? "",
    historyLength: history.length,
    canSeeAllWork: userCan(user, "view:all_work"),
    // תשובה לפנייה יזומה → SMART: הבנת הכוונה + הפעולה הנכונה ב-Monday חשובה מהעלות.
    forceTier: opts.about ? "smart" : undefined,
    buildLoop,
    // ל-ops chat "תופעת לוואי" = כתיבה ל-Monday/DB (actions), לא סתם קריאת מידע
    sideEffectCount: () => actions.length,
  });

  return { reply: routed.outcome.text ?? "סליחה, הסתבכתי. אפשר לנסח שוב בקצרה?", actions };
}
