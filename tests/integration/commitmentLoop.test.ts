/**
 * "אובדן הקשר בטיפול בשיחה" (audit 2026-10-19) — ממצאי התחייבות (commitment_overdue) אין להם
 * itemId (אין פריט Monday), אז about הישן (שדרש itemId) מעולם לא הגיע ל-runOpsChat עבורם —
 * המודל קיבל הודעת-המשך ("סידרתי את זה") בלי שום הקשר, ושאל "לאיזו משימה הכוונה".
 *
 * הבדיקה הזו: (1) ה-about המתוקן (itemId=null, findingKey="commitment:<id>") מגיע ל-runOpsChat
 * ומוביל ל-close_commitment עם ה-id הנכון — לא reply_* (שדורשים itemId אמיתי); (2) closeCommitment
 * מאמתת קיום+בעלות בצד השרת, לא רק לפי מה שהמודל "בחר" לשלוח; (3) סגירה מוצלחת סוגרת גם את
 * הלולאה מול מנוע הבקרה (finding_event + נודג' מסומן seen) — לא רק את ההתחייבות עצמה; (4) מנגנון
 * reply_* הקיים (ממצא עם itemId אמיתי) ממשיך לרוץ בדיוק כמו קודם, לא נוגעים בו.
 *
 * הערה: כל תשובה ל-about (nudge) נכפית ל-SMART tier (chat.ts: forceTier ?? (opts.about ? "smart"
 * : undefined), "דיוק > עלות") — לכן הסקריפטים כאן תמיד תחת מפתח "test-smart", לא "test-fast".
 *
 * READ-ONLY מול Monday (fetchUserOpsTasks ממוקק ל-[]). אפס AI אמיתי — _runModel מוזרק (בדיוק
 * עיקרון tests/integration/attendanceIncident1013.test.ts/tests/regression/centralCore.test.ts).
 */

import "dotenv/config";
import { vi } from "vitest";
vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUserOpsTasks: async () => [], getProjectNextAction: async () => null, matchProjectsByQuery: () => [] };
});

import { db } from "../../src/db/db.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { addCommitment, closeCommitment } from "../../src/db/repositories/commitments.js";
import { addNotification, listUnseenNudges } from "../../src/db/repositories/notifications.js";
import { isResolvedByReply } from "../../src/db/repositories/findingEvents.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelParams } from "../../src/ai/providers/types.js";
import { check, assert } from "../helpers/check.js";

const yochi = resolveUserByKey("yochi")!;

function cleanup(): void {
  db.exec(`DELETE FROM commitments WHERE created_by IN ('yochi','dov')`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE 'commitment:%'`);
  db.exec(`DELETE FROM notifications WHERE user_key IN ('yochi','dov') AND finding_key LIKE 'commitment:%'`);
}
cleanup();

function makeScriptedRunModel(scriptByModel: Record<string, { text?: string; toolCalls?: { name: string; input?: unknown }[] }[]>) {
  const cursor: Record<string, number> = {};
  const calls: RunModelParams[] = [];
  const fn: RunModelFn = async (params) => {
    calls.push(params);
    const script = scriptByModel[params.model] ?? [{ text: "x" }];
    const i = cursor[params.model] ?? 0;
    cursor[params.model] = i + 1;
    const step = script[Math.min(i, script.length - 1)]!;
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
    if (step.toolCalls) {
      const tcs: NormToolCall[] = step.toolCalls.map((t, k) => ({ id: `tc_${i}_${k}`, name: t.name, input: t.input ?? {} }));
      return { text: "", toolCalls: tcs, assistantContent: tcs.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input })), usage };
    }
    return { text: step.text ?? "", toolCalls: [], assistantContent: [{ type: "text" as const, text: step.text ?? "" }], usage };
  };
  return { fn, calls };
}
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };
const msg = (text: string): ChatMessage[] => [{ role: "user", content: text }];

async function run() {
  // ── 1. about עם itemId=null + findingKey="commitment:<id>" → המודל קורא close_commitment עם
  //    ה-id המדויק (לא reply_done/reply_*) → ההתחייבות נסגרת, finding_event+נודג' נסגרים גם ──────
  {
    const c = addCommitment({ createdBy: "yochi", toWhom: "לקוח X", what: "לשלוח הצעת מחיר" });
    const findingKey = `commitment:${c.id}`;
    // נודג' פתוח על הממצא הזה (בדיוק מה ש-escalation.ts יוצר ברמה 1) — כדי לבדוק ש-replyCloseCommitment
    // באמת סוגר אותו (markNudgesSeenForFinding), לא רק את ההתחייבות.
    addNotification("yochi", "nudge", `יוכי, התחייבות באיחור: ${c.what}. מה המצב?`, findingKey, { itemId: null, itemSource: null });

    const { fn, calls } = makeScriptedRunModel({
      "test-smart": [{ toolCalls: [{ name: "close_commitment", input: { id: c.id, outcome: "done" } }] }, { text: "סימנתי." }],
    });
    const result = await runOpsChat(yochi, msg("קיימתי את זה"), {
      session: "s-commit-1",
      clientMessageId: "cmid-commit-1",
      _runModel: fn,
      _config: TEST_CONFIG,
      about: { itemId: null, source: null, findingKey, taskName: c.what },
    });

    check("1a. system prompt מכיל את ה-id המדויק להעברה ל-close_commitment", calls[0]!.system.includes(`id=${c.id}`), String(c.id));
    check("1a. system prompt לא מכיל הנחיות reply_* (אין itemId — אין פריט Monday)", !calls[0]!.system.includes("reply_done"));
    const row = db.prepare(`SELECT status FROM commitments WHERE id=?`).get(c.id) as { status: string };
    check("1b. ההתחייבות נסגרה בפועל (status='done')", row.status === "done", row.status);
    check("1c. finding_event resolved_by_reply נכתב", isResolvedByReply(findingKey) === true);
    check("1d. הנודג' הפתוח על ההתחייבות נסגר (לא מופיע יותר ב-unseen nudges)", !listUnseenNudges("yochi").some((n) => n.findingKey === findingKey));
    check("1e. actions כוללים את אישור הסגירה", result.actions.some((a) => a.includes("קוימה")));
  }

  // ── 2. closeCommitment מאמתת בעלות בצד השרת — לא מסתמכים על כך שהמודל "קיבל" id נכון ──────────
  {
    const c = addCommitment({ createdBy: "dov", toWhom: "לקוח Y", what: "לתאם פגישה" });
    const findingKey = `commitment:${c.id}`;
    // יוכי (לא הבעלים!) "פותח" צ'אט עם about שמצביע על ההתחייבות של דוב — תרחיש הגנתי: אם המודל
    // טעה/בלבל findingKey, closeCommitment עדיין לא תאפשר סגירה של התחייבות שאינה שייכת למשתמש.
    const { fn } = makeScriptedRunModel({
      "test-smart": [{ toolCalls: [{ name: "close_commitment", input: { id: c.id, outcome: "done" } }] }, { text: "ניסיתי." }],
    });
    await runOpsChat(yochi, msg("קיימתי את זה"), {
      session: "s-commit-2",
      clientMessageId: "cmid-commit-2",
      _runModel: fn,
      _config: TEST_CONFIG,
      about: { itemId: null, source: null, findingKey, taskName: c.what },
    });

    const row = db.prepare(`SELECT status FROM commitments WHERE id=?`).get(c.id) as { status: string };
    check("2a. ההתחייבות של דוב נשארה פתוחה — יוכי לא הצליח לסגור אותה", row.status === "open", row.status);
    check("2b. שום finding_event לא נכתב על הממצא הזה (הכתיבה נכשלה)", isResolvedByReply(findingKey) === false);
  }

  // ── 2c. closeCommitment הגולמית — ישירות, בלי chat/AI בכלל: קיום+בעלות ───────────────────────
  {
    assert(closeCommitment(999999999, "done", "yochi") === false, "2c. id לא קיים → false");
    const c = addCommitment({ createdBy: "dov", toWhom: "Z", what: "w" });
    assert(closeCommitment(c.id, "done", "yochi") === false, "2d. לא הבעלים → false, לא נסגר");
    assert(closeCommitment(c.id, "done", "dov") === true, "2e. הבעלים האמיתי → true");
    assert(closeCommitment(c.id, "done", "dov") === false, "2f. כבר סגורה → false (לא idempotent-true, לא כפילות)");
  }

  // ── 3. המשך-שיחה: אותו about נשלח שוב בתור "ההודעה הבאה" (session/clientMessageId שונים, בדיוק
  //    כמו שה-UI שולח about מחדש בכל שליחה כל עוד state.activeNudge פתוח) — הקשר לא אובד בפעם
  //    השנייה: תשובה לא-ברורה לא קוראת כלי, ותשובה ברורה בהמשך כן סוגרת ───────────────────────
  {
    const c = addCommitment({ createdBy: "yochi", toWhom: "לקוח Z", what: "לשלוח חוזה" });
    const findingKey = `commitment:${c.id}`;
    const about = { itemId: null, source: null, findingKey, taskName: c.what };

    const unclear = makeScriptedRunModel({ "test-smart": [{ text: "אפשר לדעת יותר פרטים?" }] });
    await runOpsChat(yochi, msg("עוד לא"), {
      session: "s-commit-3",
      clientMessageId: "cmid-commit-3a",
      _runModel: unclear.fn,
      _config: TEST_CONFIG,
      about,
    });
    const afterFirst = db.prepare(`SELECT status FROM commitments WHERE id=?`).get(c.id) as { status: string };
    check("3a. תשובה לא-ברורה לא סוגרת כלום", afterFirst.status === "open");

    const clear = makeScriptedRunModel({
      "test-smart": [{ toolCalls: [{ name: "close_commitment", input: { id: c.id, outcome: "done" } }] }, { text: "סימנתי." }],
    });
    await runOpsChat(yochi, msg("קיימתי את זה בסוף"), {
      session: "s-commit-3",
      clientMessageId: "cmid-commit-3b",
      _runModel: clear.fn,
      _config: TEST_CONFIG,
      about, // אותו about בדיוק — ההקשר עדיין קיים בהודעת-ההמשך
    });
    const afterSecond = db.prepare(`SELECT status FROM commitments WHERE id=?`).get(c.id) as { status: string };
    check("3b. הודעת-ההמשך (עם אותו about) סוגרת את ההתחייבות בהצלחה — ההקשר לא אבד", afterSecond.status === "done", afterSecond.status);
  }

  // ── 4. non-regression: ממצא עם itemId אמיתי ממשיך לקבל את בלוק reply_* המקורי, ללא שינוי —
  //    בלי להפעיל reply_done בפועל (זה היה מגיע עד Monday אמיתי; מעניין אותנו רק *מה הוזרק
  //    ל-system prompt*, לא לבדוק פה מחדש את reply_* עצמו — זה כבר מכוסה ב-tests/integration/loop.test.ts
  //    ודומיו). מודל מדומה שמחזיר טקסט בלבד, בלי tool_use, כדי שלא תהיה שום קריאת רשת. ────────────
  {
    const { fn, calls } = makeScriptedRunModel({
      "test-smart": [{ text: "סיימתי, תודה." }],
    });
    await runOpsChat(yochi, msg("סיימתי"), {
      session: "s-commit-4",
      clientMessageId: "cmid-commit-4",
      _runModel: fn,
      _config: TEST_CONFIG,
      about: { itemId: "123456", source: "general", findingKey: "overdue:123456", taskName: "בדיקה" },
    });
    check("4a. system prompt (itemId אמיתי) מכיל את הנחיות reply_* הרגילות — ללא שינוי", calls[0]!.system.includes("reply_done"));
    check("4b. system prompt לא מכיל את בלוק ההתחייבות (סימן ייחודי לבלוק הממוקד)", !calls[0]!.system.includes("לא משימת Monday"));
  }

  cleanup();
}

await run();
