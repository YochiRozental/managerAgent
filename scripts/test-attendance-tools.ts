/**
 * מודול נוכחות — חיבור לשכבת הכלים המשותפת (ops/agentTools.ts + ai/sharedTools.ts). בודק:
 *   • messageSeed מוזרק ל-execute דרך transformInput (host-injected, לא חלק מה-input_schema).
 *   • כשל "רגיל" (state machine דוחה) הופך ל-throw בגבול ה-AgentTool (throwIfFailed) — כך
 *     שהדיספצ'ר המשותף (dispatchToolDefinition) לא מריץ את SHARED_TOOL_UI_EFFECT על כישלון
 *     (שהיה מציג "✅ בוצע" על פעולה שבאמת נכשלה).
 *   • dispatchToolDefinition מחזיר sideEffect=true על הצלחה, false על כישלון.
 *
 *   npm run test:attendance-tools
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { env } from "../src/config/env.js";
import { logger } from "../src/utils/logger.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { buildMessageIdempotencySeed } from "../src/ops/attendanceEngine.js";
import { AGENT_TOOLS, buildAgentTools } from "../src/ops/agentTools.js";
import { buildSharedToolDefinition } from "../src/ai/sharedTools.js";
import { dispatchToolDefinition } from "../src/ai/dispatcher.js";
import { checkAttendanceDayStart } from "../src/ops/attendance.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const yochi = resolveUserByKey("yochi")!;
const TEST_USERS = ["yochi"];
// ה-AgentTools (ops/agentTools.ts) קוראים DateTime.now() בפועל בתוך execute — לא מקבלים `now`
// מוזרק (זה נכון לייצור: פעולה בזמן אמת היא תמיד "עכשיו"). הבדיקה הזו, בשונה מ-test-attendance.ts
// (שבודקת את ops/attendance.ts הטהור עם now מוזרק), חייבת לעבוד על ה-work_date האמיתי של היום.
const day = DateTime.now().setZone(env.TIMEZONE).toISODate()!;

function cleanup(): void {
  const placeholders = TEST_USERS.map(() => "?").join(",");
  db.prepare(`DELETE FROM attendance_events WHERE user_key IN (${placeholders}) AND work_date = ?`).run(...TEST_USERS, day);
  db.prepare(`DELETE FROM attendance_days WHERE user_key IN (${placeholders}) AND work_date = ?`).run(...TEST_USERS, day);
}
cleanup();

const turnCounter = { n: 0 };
const seenTurns = new Map<string, number>();
function seed(text: string): string {
  let ordinal = seenTurns.get(text);
  if (ordinal === undefined) {
    ordinal = turnCounter.n++;
    seenTurns.set(text, ordinal);
  }
  return buildMessageIdempotencySeed({ scopeId: "test-session", turnOrdinal: ordinal });
}

// בדיקות הדיספצ'ר/idempotency/state-machine למטה בודקות התנהגות שלא תלויה במצב הפיילוט (ATTENDANCE_
// PILOT_USER_KEYS/ATTENDANCE_MODULE_ENABLED האמיתיים מה-.env) — pilotEnabledTools מזריק allowlist
// מדומה (attendanceEnabledForUser → true) כדי שהבדיקות האלה ימשיכו לעבוד בלי תלות בקונפיגורציית
// הפיילוט בפועל. AGENT_TOOLS (ברירת המחדל האמיתית) נשאר למטה לבדיקת "משתמש לא מורשה" במפורש —
// ר' סעיף ההגנה-בעומק.
const pilotEnabledTools = buildAgentTools({ attendanceEnabledForUser: () => true });

function findTool(name: string) {
  const t = pilotEnabledTools.find((x) => x.name === name);
  if (!t) throw new Error(`AgentTool '${name}' לא נמצא ב-registry`);
  return t;
}

function findRealTool(name: string) {
  const t = AGENT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`AgentTool '${name}' לא נמצא ב-registry`);
  return t;
}

async function run() {
  // יום פתוח כדי שיהיה מה לתקוף (על ה-work_date האמיתי של היום — ר' הערה למעלה)
  checkAttendanceDayStart(yochi, DateTime.now().setZone(env.TIMEZONE));

  // ── messageSeed מוזרק דרך transformInput, לא נראה למודל (לא ב-input_schema) ──
  const breakStartTool = findTool("attendance_break_start");
  check("attendance_break_start: אין messageSeed ב-input_schema (host-injected בלבד)", !JSON.stringify(breakStartTool.input_schema).includes("messageSeed"));

  const mySeed = seed("יצאתי");
  const def = buildSharedToolDefinition(breakStartTool, { transformInput: (input) => ({ ...input, messageSeed: mySeed }) });
  const result = await dispatchToolDefinition(def, {}, { user: yochi });
  check("דיספצ'ר: break_start תקין → sideEffect=true", result.sideEffect === true, JSON.stringify(result));
  const parsed = JSON.parse(result.content) as { ok: boolean; message: string };
  check("דיספצ'ר: content הוא JSON של AttendanceActionResult", parsed.ok === true && typeof parsed.message === "string");

  // retry עם אותו seed בדיוק דרך הדיספצ'ר — idempotent, עדיין sideEffect=true (לא שגיאה)
  const retryResult = await dispatchToolDefinition(def, {}, { user: yochi });
  check("דיספצ'ר: retry עם אותו messageSeed — עדיין מצליח (idempotent), לא שגיאת state machine", retryResult.sideEffect === true, retryResult.content);

  // ── כשל state machine הופך ל-throw → sideEffect=false, בלי לקרוא ל-onExecuted (ה-UI effect) ──
  // seed *אחר* (לא retry) — "פעולה שנייה" אמיתית, שצריכה transformInput נפרד כדי לקבל seed אחר.
  let uiEffectCalled = false;
  const dupSeed = seed("יצאתי-שוב-ממש");
  const def2 = buildSharedToolDefinition(breakStartTool, { transformInput: (input) => ({ ...input, messageSeed: dupSeed }) });
  const realFail = await dispatchToolDefinition(def2, {}, { user: yochi }, {
    onExecuted: () => {
      uiEffectCalled = true;
    },
  });
  check("דיספצ'ר: break_start שני (כבר on_break) → sideEffect=false", realFail.sideEffect === false, realFail.content);
  check("דיספצ'ר: תוכן השגיאה מכיל את ההודעה בעברית", realFail.content.includes("כבר בהפסקה"), realFail.content);
  check("דיספצ'ר: onExecuted (ה-UI effect) *לא* נקרא על כישלון — אין 'הצלחה' מזויפת", !uiEffectCalled);

  // ── permission: אין report:hours → נדחה לפני execute כלל ──
  const goldi = resolveUserByKey("goldi")!; // role=finance, יש לה report:hours בפועל (ר' roles.ts) — נבדוק מישהו בלי
  void goldi;
  const ruchama = resolveUserByKey("ruchama")!; // יש לה report:hours (planner) — גם היא לא טוב לבדיקת-שלילה
  void ruchama;
  // כל 6 התפקידים בספר הצוות כוללים report:hours (owner/admin/כולם) — אין משתמש-בדיקה בלי ההרשאה
  // הזו היום; בודקים לפחות שהבדיקה *קיימת* ונכונה כש-user=null (לא מזוהה).
  const nullUserResult = await dispatchToolDefinition(def, {}, { user: null });
  check("דיספצ'ר: user=null → נדחה (sideEffect=false), לא מגיע ל-execute", nullUserResult.sideEffect === false);

  // ── הגנת-עומק: attendanceEnabledForUser (לא פיילוט/דגל כבוי) — "משתמש לא מורשה" (בדיקת-מוכנות-
  // לפיילוט, 2026-10-12). משתמש **עם** report:hours (יש לו לכולם) אבל לא ברשימת הפיילוט/דגל כבוי —
  // משתמשים כאן ב-AGENT_TOOLS *האמיתי* (ברירת המחדל, לא pilotEnabledTools) כדי לבדוק את ה-allowlist
  // האמיתי מה-.env בפועל: ATTENDANCE_PILOT_USER_KEYS שם ריק כברירת מחדל → אפילו יוכי נדחה. זה בדיוק
  // הממצא שגילתה בדיקת-המוכנות: לפני התוספת הזו, requiredPermission=report:hours *לבדו* היה מספיק
  // כדי שהדיספצ'ר יבצע את הפעולה בפועל — בלי קשר לרשימת הפיילוט.
  const realBreakStartTool = findRealTool("attendance_break_start");
  const realSeed = seed("יצאתי-לא-מורשה");
  const realDef = buildSharedToolDefinition(realBreakStartTool, { transformInput: (input) => ({ ...input, messageSeed: realSeed }) });
  const unauthorizedResult = await dispatchToolDefinition(realDef, {}, { user: yochi });
  check(
    "הגנת-עומק: משתמש לא-פיילוט (יוכי, לפי ATTENDANCE_PILOT_USER_KEYS האמיתי בריק) → נדחה (sideEffect=false)",
    unauthorizedResult.sideEffect === false,
    unauthorizedResult.content,
  );
  check(
    "הגנת-עומק: הודעת השגיאה מסבירה שהמודול לא פעיל, לא שגיאת state-machine מקרית",
    unauthorizedResult.content.includes("מודול הנוכחות לא פעיל"),
    unauthorizedResult.content,
  );

  cleanup();
}

run()
  .then(() => {
    if (failed > 0) {
      logger.error(`${failed} בדיקות נכשלו`);
      process.exit(1);
    }
    logger.info("כל הבדיקות עברו ✅");
  })
  .catch((err) => {
    logger.error({ err }, "בדיקה קרסה");
    process.exit(1);
  });
