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

import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { env } from "../config/env.js";
import type { IdentifiedUser } from "../identity/index.js";
import {
  fetchUserOpsTasks,
  getProjectNextAction,
  type OpsTask,
} from "../integrations/monday/opsRead.js";
import { logger } from "../utils/logger.js";
import { updateTask } from "./actions.js";
import { buildDashboardViews, type DashboardTask } from "./dashboard.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";
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

function systemPrompt(user: IdentifiedUser): string {
  const now = DateTime.now().setZone(env.TIMEZONE);
  return [
    `אתה העוזר התפעולי של ${user.name} במשרד האדריכלים "גוטליב אדריכלים". תפקיד המשתמש: ${user.roleDescription}`,
    `היום ${now.toFormat("EEEE, dd/MM/yyyy")}, השעה ${now.toFormat("HH:mm")} (${env.TIMEZONE}).`,
    "דבר עברית, קצר, חם ולעניין. אתה בצד של העובד — עוזר לו לנהל את היום, לא בודק אותו.",
    "",
    "איך לעבוד:",
    "• כשהעובד אומר 'בוקר טוב' / 'מה יש לי' / 'מה על הפרק' — קרא get_today_tasks. הצג למשתמש את השדה 'briefing' שחוזר משם כמעט כמו שהוא — מותר להוסיף ברכה קצרה בהתאם לשעה ולסיים ב'על מה מתחילים?', אבל אל תשנה את רשימת הפרויקטים, את שורות 'עכשיו:' ואת סימוני האיחור/הקריטי. אל תוסיף 'דורש תשומת לב' / 'מחכים ממני' אלא אם ביקשו.",
    "• כשהעובד מדווח שביצע / התקדם / שינה משהו — זהה את המשימה עם find_task (לפי מה שהוא תיאר). אם יש כמה התאמות — הצג אותן ושאל איזו. אם אין — אמור זאת ובקש תיאור מדויק יותר.",
    "• אחרי שזיהית — עדכן ב-Monday: mark_done כשסיים, set_status ל'בעבודה' כשהתחיל, add_note לעדכון ביניים. אשר בקצרה מה עדכנת ואז שאל: 'מה הבא שאתה עובד עליו?'",
    "• 'תקוע' / 'חסום' / 'מחכה ל...' — קרא report_blocker עם תיאור החסם.",
    "",
    "כללים:",
    "• לעולם אל תעדכן ב-Monday בלי שהעובד אמר מפורשות שהוא ביצע או שינה משהו. שאלה או בקשת מידע אינה דיווח.",
    "• אל תמציא משימות או שמות. השתמש רק במה ש-get_today_tasks ו-find_task מחזירים.",
    "• אם פעולה נכשלה — אמור מה קרה, אל תעמיד פנים שהצליחה.",
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
  input_schema: Anthropic.Tool.InputSchema;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export async function runOpsChat(user: IdentifiedUser, history: ChatMessage[]): Promise<OpsChatResult> {
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
  ];

  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt(user),
      tools: anthropicTools,
      messages,
    });

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
      // אם בסבב הזה נשלף תדריך היום ולא בוצעו עדכונים — מגישים אותו כפי שהוא, עם ברכה קצרה,
      // במקום הניסוח החופשי של המודל (שנוטה לאבד את מבנה 'עכשיו:' לכל פרויקט).
      if (capturedBriefing && actions.length === 0) {
        const hour = now.hour;
        const greet = hour < 12 ? "בוקר טוב" : hour < 17 ? "צהריים טובים" : "ערב טוב";
        return { reply: `${greet} ${user.name} ☀️\n\n${capturedBriefing}\n\nעל מה מתחילים?`, actions };
      }
      return { reply: text, actions };
    }

    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const tool = tools.find((t) => t.name === tu.name);
      let content: string;
      try {
        content = JSON.stringify(await tool!.run((tu.input ?? {}) as Record<string, unknown>));
      } catch (err) {
        logger.warn({ err, tool: tu.name, user: user.key }, "כלי צ'אט תפעולי נכשל");
        content = `שגיאה: ${(err as Error).message}`;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content });
    }
    messages.push({ role: "user", content: results });
  }

  return { reply: "סליחה, הסתבכתי. אפשר לנסח שוב בקצרה?", actions };
}
