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
import { fetchUserOpsTasks, type OpsTask } from "../integrations/monday/opsRead.js";
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
    "• כשהעובד אומר 'בוקר טוב' / 'מה יש לי' / 'מה על הפרק' — קרא get_today_tasks והצג בקצרה: כמה משימות, מה באיחור, מה דחוף. אל תשפוך רשימה ארוכה — הבלט את החשוב.",
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

  const refresh = async () => {
    tasks = await fetchUserOpsTasks(user.mondayUserId!);
  };

  const findTask = (itemId: string): OpsTask | undefined => tasks.find((t) => t.itemId === itemId);

  const tools: ToolDef[] = [
    {
      name: "get_today_tasks",
      description: "מחזיר את המשימות של המשתמש להיום: מה לטפל בו היום, מה דורש תשומת לב, ומה אחרים מחכים לו.",
      input_schema: { type: "object", properties: {} },
      run: async () => {
        const v = buildDashboardViews(tasks, now);
        return {
          counts: { today: v.myDay.length, needsAttention: v.needsAttention.length, waitingOnMe: v.waitingOnMe.length, totalOpen: tasks.length },
          today: v.myDay.map(fmtTask),
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
