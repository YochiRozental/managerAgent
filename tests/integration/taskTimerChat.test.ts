/**
 * מדידת זמן על משימות — חיבור ל-runOpsChat (chat.ts): ברירת מחדל כבויה, חשיפת הכלים, הגשת הטקסט מילה
 * במילה, החלפה רק באישור המשתמש, תזכורת (throttle) בצפייה במשימות, ושורת הקשר בפרומפט.
 * מודל מדומה בלבד (אפס AI אמיתי), Monday ממוקק (אפס רשת), DB זמני מבודד. פועל על "היום" האמיתי כי
 * הכלים קוראים DateTime.now() — לכן מנקים את הטבלאות של yochi לפני.
 */

import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  const mk = (itemId: string, name: string) => ({
    source: "project_stage" as const,
    itemId,
    name,
    url: "",
    context: "בלומינג",
    projectId: "p1",
    stageName: "שלב 2",
    status: "בעבודה",
    assignees: "Yochi",
  });
  return {
    ...actual,
    fetchUserOpsTasks: async () => [mk("555", "שרטוט חזיתות"), mk("556", "תכניות קומה")],
    getProjectNextAction: async () => null,
    matchProjectsByQuery: () => [],
  };
});
import { DateTime } from "luxon";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/db.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelParams } from "../../src/ai/providers/types.js";
import { getActiveSegment, listSegmentsForDate } from "../../src/db/repositories/taskTimers.js";

const yochi = resolveUserByKey("yochi")!;
const today = DateTime.now().setZone(env.TIMEZONE).toISODate()!;

type Step = { text?: string; toolCalls?: { name: string; input?: unknown }[] };
function scripted(steps: Step[]) {
  let i = 0;
  const calls: RunModelParams[] = [];
  const fn: RunModelFn = async (params) => {
    calls.push(params);
    const step = steps[Math.min(i++, steps.length - 1)]!;
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
    if (step.toolCalls) {
      const tcs: NormToolCall[] = step.toolCalls.map((t, k) => ({ id: `tc_${i}_${k}`, name: t.name, input: t.input ?? {} }));
      return { text: "", toolCalls: tcs, assistantContent: tcs.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input })), usage };
    }
    return { text: step.text ?? "", toolCalls: [], assistantContent: [{ type: "text" as const, text: step.text ?? "" }], usage };
  };
  return { fn, calls };
}
const CONFIG = { fast: { provider: "anthropic" as const, model: "t-fast" }, smart: { provider: "anthropic" as const, model: "t-smart" }, costLogging: false };
const msgs = (...texts: string[]): ChatMessage[] => texts.map((t, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: t }));
const on = () => true;
let n = 0;
const base = (fn: RunModelFn, timer: boolean) => ({
  session: "s-timer-chat",
  clientMessageId: `tc-${++n}`,
  _runModel: fn,
  _config: CONFIG,
  _attendanceEnabledForUser: on,
  ...(timer ? { _taskTimerEnabledForUser: on } : {}),
});

beforeAll(() => {
  for (const t of ["task_timer_segments", "task_timer_state"]) db.prepare(`DELETE FROM ${t} WHERE user_key='yochi'`).run();
  db.prepare(`DELETE FROM attendance_events WHERE user_key='yochi' AND work_date=?`).run(today);
  db.prepare(`DELETE FROM attendance_days WHERE user_key='yochi' AND work_date=?`).run(today);
});

const toolNames = (p: RunModelParams) => p.tools.map((t) => t.name);

describe("ברירת מחדל כבויה", () => {
  it("בלי דגל — אף כלי טיימר לא נחשף למודל, ושורת הטיימר לא בפרומפט", async () => {
    const { fn, calls } = scripted([{ text: "שלום" }]);
    const r = await runOpsChat(yochi, msgs("מה נשמע"), base(fn, false));
    expect(r.reply).toContain("שלום");
    expect(toolNames(calls[0]!).filter((x) => x.startsWith("timer_"))).toEqual([]);
    expect(JSON.stringify(calls[0]!)).not.toContain("[טיימר פעיל]");
    expect(listSegmentsForDate("yochi", today)).toHaveLength(0);
  });
});

describe("עם הדגל (פיילוט)", () => {
  it("הכלים נחשפים; הפעלה מוגשת מילה במילה ונרשמת ב-DB", async () => {
    const { fn, calls } = scripted([{ toolCalls: [{ name: "timer_start", input: { itemId: "555" } }] }, { text: "ניסוח חופשי של המודל שלא אמור להופיע" }]);
    const r = await runOpsChat(yochi, msgs("מתחיל לעבוד על החזיתות"), base(fn, true));
    expect(toolNames(calls[0]!)).toEqual(expect.arrayContaining(["timer_start", "timer_confirm_switch", "timer_stop", "timer_resume", "timer_status", "timer_report"]));
    expect(r.reply).toContain("מצוין! הפעלתי טיימר למשימה 'שרטוט חזיתות' בפרויקט 'בלומינג'.");
    expect(r.reply).not.toContain("ניסוח חופשי");
    expect(r.actions).toContain("⏱ טיימר הופעל");
    expect(getActiveSegment("yochi")!.itemId).toBe("555");
  });

  it("שורת הקשר 'טיימר פעיל' נכנסת לפרומפט רק כשפועל טיימר", async () => {
    const { fn, calls } = scripted([{ text: "אוקיי" }]);
    await runOpsChat(yochi, msgs("תודה"), base(fn, true));
    expect(JSON.stringify(calls[0]!)).toContain("[טיימר פעיל]");
  });

  it("משימה אחרת: שאלה מילה במילה, בלי החלפה; 'כן' בהודעה נפרדת מחליף", async () => {
    const ask = scripted([{ toolCalls: [{ name: "timer_start", input: { itemId: "556" } }] }, { text: "x" }]);
    const r1 = await runOpsChat(yochi, msgs("עכשיו אני על התכניות"), base(ask.fn, true));
    expect(r1.reply).toContain("כרגע פועל טיימר למשימה 'שרטוט חזיתות'. האם לעצור אותו ולהתחיל טיימר למשימה החדשה?");
    expect(getActiveSegment("yochi")!.itemId).toBe("555");

    // המודל מנסה לאשר בעצמו כשהעובד לא אישר ("מה עם הקומה?") — נחסם בקוד
    const bad = scripted([{ toolCalls: [{ name: "timer_confirm_switch" }] }, { text: "x" }]);
    const rBad = await runOpsChat(yochi, msgs("עכשיו אני על התכניות", "שאלה...", "מה עם התכניות של הקומה?"), base(bad.fn, true));
    expect(getActiveSegment("yochi")!.itemId).toBe("555");
    expect(rBad.reply).toContain("לא התקבל אישור מפורש");

    const yes = scripted([{ toolCalls: [{ name: "timer_confirm_switch" }] }, { text: "x" }]);
    const r2 = await runOpsChat(yochi, msgs("עכשיו אני על התכניות", r1.reply, "כן"), base(yes.fn, true));
    expect(r2.reply).toContain("מצוין! הפעלתי טיימר למשימה 'תכניות קומה'");
    expect(getActiveSegment("yochi")!.itemId).toBe("556");
    expect(r2.actions).toContain("⏱ הטיימר הוחלף");
  });

  it("צפייה במשימות בזמן טיימר: תזכורת בסוף התשובה פעם אחת ב-10 דקות; לא עוצרת ולא מפעילה", async () => {
    const find = () => scripted([{ toolCalls: [{ name: "find_task", input: { query: "חזיתות" } }] }, { text: "מצאתי את המשימה." }]);
    const r1 = await runOpsChat(yochi, msgs("מה עם החזיתות?"), base(find().fn, true));
    expect(r1.reply).toContain("מצאתי את המשימה.");
    expect(r1.reply).toContain("שים לב, עדיין פועל טיימר למשימה 'תכניות קומה'. האם לעצור אותו?");
    const r2 = await runOpsChat(yochi, msgs("ועוד פעם החזיתות?"), base(find().fn, true));
    expect(r2.reply).not.toContain("שים לב, עדיין פועל טיימר");
    expect(getActiveSegment("yochi")!.itemId).toBe("556"); // לא נעצר, לא הוחלף
    expect(listSegmentsForDate("yochi", today).filter((s) => s.endedAt === null)).toHaveLength(1);
  });

  it("אין תזכורת כשבהודעה נעשתה פעולת טיימר", async () => {
    const { fn } = scripted([{ toolCalls: [{ name: "find_task", input: { query: "x" } }, { name: "timer_status" }] }, { text: "x" }]);
    const r = await runOpsChat(yochi, msgs("על מה אני עובד?"), base(fn, true));
    expect(r.reply).toContain("אתה עובד כרגע על");
    expect(r.reply).not.toContain("שים לב, עדיין פועל");
  });

  it("'עצור את הטיימר' — נעצר; אחריו אין שורת הקשר בפרומפט", async () => {
    const stop = scripted([{ toolCalls: [{ name: "timer_stop" }] }, { text: "x" }]);
    const r = await runOpsChat(yochi, msgs("עצור את הטיימר"), base(stop.fn, true));
    expect(r.reply).toContain("עצרתי את הטיימר למשימה 'תכניות קומה'");
    expect(getActiveSegment("yochi")).toBeNull();
    const after = scripted([{ text: "אוקיי" }]);
    await runOpsChat(yochi, msgs("תודה"), base(after.fn, true));
    expect(JSON.stringify(after.calls[0]!)).not.toContain("[טיימר פעיל]");
  });
});
