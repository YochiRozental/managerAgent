/**
 * שרת החלונית — מגיש את מנוע שלוש התצוגות + תצוגת הבקרה של מוטי + עדכון משימות, ואת ה-UI עצמו.
 *
 * הרצה:  npm run window   →   http://localhost:3001
 *
 * כל בקשת API עוברת דרך שכבת הזהות: readSession → resolveUserByKey → הרשאות.
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { performance } from "node:perf_hooks";
import {
  resolveUserByEmail,
  resolveUserByKey,
  TEAM_DIRECTORY,
  type IdentifiedUser,
} from "../identity/index.js";
import {
  appendChatTurn,
  clearChatHistory,
  deleteSession,
  getSessionMessages,
  latestSessionId,
  listSessions,
  newSessionId,
} from "../db/repositories/chatHistory.js";
import { listOpenCommitments, listUserCommitments } from "../db/repositories/commitments.js";
import { findWorkDateForReminder } from "../db/repositories/attendanceDays.js";
import {
  listUnseenNotifications,
  listUnseenNudges,
  listNotificationsPage,
  markNotificationsSeen,
  markNotificationSeenById,
  type Notification,
} from "../db/repositories/notifications.js";
import { subscribeNudges } from "../ops/nudgeBus.js";
import { subscribeNotifications } from "../ops/notificationBus.js";
import { approveApproval, giveApprovalInstruction, rejectApproval } from "../ops/approvalActions.js";
import { listApprovalsForManager, recoverStuckApprovals } from "../db/repositories/managerApprovals.js";
import { listApprovalMessages } from "../db/repositories/approvalMessages.js";
import { listFollowups, recoverStuckFollowups } from "../db/repositories/controlFollowups.js";
import { recordHeartbeat } from "../db/repositories/systemHealth.js";
import { recoverStuckChatMessageClaims } from "../db/repositories/chatMessageDedup.js";
import { runDedupedChatTurn, ChatMessageConflictError, ChatMessageStillProcessingError } from "./chatDedup.js";
import { createHash, randomUUID } from "node:crypto";
import {
  recordChatPerfMetricSafe,
  recordClientTimingSafe,
  getChatPerfSummarySafe,
} from "../db/repositories/chatPerfMetrics.js";
import {
  recordChatPerfStepsSafe,
  getChatPerfStepsForRequestSafe,
  type ChatPerfStepEntry,
} from "../db/repositories/chatPerfSteps.js";
import { updateTask, type TaskUpdateAction } from "../ops/actions.js";
import { runOpsChat, type ChatMessage } from "../ops/chat.js";
import type { IncomingAboutContext } from "../ops/loopReply.js";
import { getControlScan } from "../ops/controlScan.js";
import { runCrmScan } from "../ops/crmScan.js";
import { getEmployeeDashboard } from "../ops/dashboard.js";
import { buildEndOfDaySummary } from "../ops/eodSummary.js";
import { runDailyControlCycle } from "../ops/escalation.js";
import { getHealth, noteIncident } from "../ops/health.js";
import { getOversightReport } from "../ops/oversight.js";
import { startScheduler } from "../ops/scheduler.js";
import { buildWeeklyReport } from "../ops/weeklyReport.js";
import { mondayItemUrl, type OpsTaskSource } from "../integrations/monday/opsRead.js";
import { logger } from "../utils/logger.js";
import { REQUIRE_ACCESS_LINK, verifyAccessToken } from "./accessLink.js";
import { clearSessionCookie, createSessionCookie, readSession } from "./session.js";

const PORT = Number(process.env.PORT ?? 3001);
const UI_HTML = await readFile(new URL("./ui.html", import.meta.url), "utf8");

// שלא כמו סוכן ה-WhatsApp (src/index.ts) — שרת החלונית לא נופל על תקלה זמנית של Monday/AI/Google.
// הוא מרים HTTP, מגיש את החלונית ומריץ את המתזמן; תקלה ברקע נרשמת כ-DEGRADED ונחשפת ב-/health,
// והשרת ממשיך. מצב תקוע אמיתי מטופל ע"י ניטור חיצוני של /health + restart של Docker/PM2.
process.on("unhandledRejection", (err) => {
  logger.error(err, "[degraded] unhandledRejection — השרת ממשיך");
  noteIncident("unhandledRejection", err instanceof Error ? err.message : String(err));
});
process.on("uncaughtException", (err) => {
  logger.error(err, "[degraded] uncaughtException — השרת ממשיך");
  noteIncident("uncaughtException", err.message);
});

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

/**
 * audit שלב ה: hash של תוכן ההודעה+ה-context — לא קריפטוגרפי, רק "לגלות אם clientMessageId
 * נשלח פעמיים עם תוכן אחר" (client bug/שימוש חוזר, ר' chatDedup.ts). retry לגיטימי (אותו client
 * שולח את אותה הודעה בדיוק שוב) מגיע עם hash זהה.
 */
function hashChatContent(text: string, about: IncomingAboutContext | undefined): string {
  return createHash("sha256").update(JSON.stringify({ text, about })).digest("hex");
}

/** מזהה משתמש לפי מייל, שם (עברית) או מפתח פנימי. */
function resolveByIdentifier(identifier: string): IdentifiedUser | null {
  const q = identifier.trim().toLowerCase();
  if (!q) return null;
  const byEmail = resolveUserByEmail(q);
  if (byEmail) return byEmail;
  const byKey = resolveUserByKey(q);
  if (byKey) return byKey;
  const member = TEAM_DIRECTORY.find((m) => m.name.toLowerCase() === q || m.name.includes(identifier.trim()));
  return member ? resolveUserByKey(member.key) : null;
}

function currentUser(req: IncomingMessage): IdentifiedUser | null {
  const key = readSession(req.headers.cookie);
  return key ? resolveUserByKey(key) : null;
}

/**
 * מצרף mondayUrl (אם יש item_id+item_source תקינים) ו-context.workDate להתראות נוכחות ישנות
 * (audit "תזכורות נוכחות נראות כפולות", 2026-10-19) — לתצורת ה-API בלבד, לא נוגע ב-DB. התראת
 * נוכחות חדשה כבר נושאת context.workDate מרגע היצירה (attendanceReminderScheduler.ts) — כאן רק
 * fallback לרשומות ישנות (קריאה-בלבד, דרך findWorkDateForReminder — התאמה מדויקת, לא ניחוש;
 * null כש-אין התאמה חד-משמעית, אז פשוט לא מוצג תאריך, לא מוצג תאריך שגוי).
 */
function serializeNotification(n: Notification) {
  let context = n.context;
  if (n.kind === "attendance_reminder" && typeof context?.workDate !== "string") {
    const workDate = findWorkDateForReminder(n.userKey, n.createdAt);
    if (workDate) context = { ...(context ?? {}), workDate };
  }
  return {
    ...n,
    context,
    mondayUrl: n.itemId && n.itemSource ? mondayItemUrl(n.itemId, n.itemSource as OpsTaskSource) : null,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      // ציבורי (בלי עוגייה) — לניטור חיצוני. לא חושף סודות, רק מצב תהליכים/עבודות/גיבוי.
      const health = getHealth();
      return send(res, health.status === "ok" ? 200 : 503, health);
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      // קישור כניסה אישי: /?t=<token> → מזהה ומכניס ישירות. ה-token נשאר ב-URL כדי שהסימנייה
      // תמשיך לעבוד גם אחרי שהעוגייה פגה.
      const token = url.searchParams.get("t");
      const headers: Record<string, string> = {};
      if (token) {
        const userKey = verifyAccessToken(token);
        if (userKey) {
          headers["Set-Cookie"] = createSessionCookie(userKey);
          logger.info({ user: userKey }, "כניסה דרך קישור אישי");
        }
      }
      return send(res, 200, UI_HTML, headers);
    }

    if (req.method === "GET" && path === "/api/users") {
      if (REQUIRE_ACCESS_LINK) {
        return send(res, 403, { error: "כניסה למערכת היא דרך קישור אישי בלבד", requireLink: true });
      }
      // רשימת השמות למסך הכניסה. כלי פנימי — הרשימה לא סודית.
      return send(res, 200, {
        users: TEAM_DIRECTORY.map((m) => ({ key: m.key, name: m.name, role: m.role })),
      });
    }

    if (req.method === "POST" && path === "/api/login") {
      if (REQUIRE_ACCESS_LINK) {
        return send(res, 403, { error: "כניסה למערכת היא דרך קישור אישי בלבד", requireLink: true });
      }
      const body = await readJsonBody(req);
      const user = resolveByIdentifier(String(body.identifier ?? ""));
      if (!user) return send(res, 401, { error: "לא זוהה משתמש בשם או במייל הזה" });
      logger.info({ user: user.key }, "כניסה לחלונית");
      return send(res, 200, { user: publicUser(user) }, { "Set-Cookie": createSessionCookie(user.key) });
    }

    if (req.method === "POST" && path === "/api/logout") {
      return send(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (req.method === "GET" && path === "/api/session") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      return send(res, 200, { user: publicUser(user) });
    }

    if (req.method === "GET" && path === "/api/dashboard") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const dash = await getEmployeeDashboard(user);
      return send(res, 200, dash);
    }

    if (req.method === "POST" && path === "/api/chat") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      // ניטור ביצועים (2026-10-14) — requestId נפרד מ-clientMessageId: הוא per-HTTP-attempt (גם
      // retry מהדפדפן מקבל requestId חדש), בזמן ש-clientMessageId הוא idempotency per-שליחה-אמיתית.
      // serverStart הוא שעון מונוטוני (performance.now()) — לא Date.now(), לא מניח סנכרון עם הדפדפן.
      const requestId = randomUUID();
      const serverStart = performance.now();
      const body = await readJsonBody(req);
      const raw = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
      // מגבילים היסטוריה כדי לשמור על עלות/מהירות; שומרים את הזוגות האחרונים.
      const messages = raw
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-20);
      if (messages.length === 0 || messages[messages.length - 1]!.role !== "user") {
        return send(res, 400, { error: "אין הודעה" });
      }
      const session = typeof body.session === "string" && body.session ? body.session : newSessionId();
      // audit שלב ה: מזהה שהלקוח הקצה (ui.html, crypto.randomUUID()) לפני השליחה — ר' chatDedup.ts.
      // ולידציה בסיסית בלבד (לא קריפטוגרפית): מחרוזת סבירה, לא ריקה, גבול אורך — משמש כמפתח DB.
      const rawClientMessageId = body.clientMessageId;
      const clientMessageId =
        typeof rawClientMessageId === "string" && rawClientMessageId.length > 0 && rawClientMessageId.length <= 128
          ? rawClientMessageId
          : undefined;
      // תשובה לפנייה יזומה של הבקרה — ה-UI שולח את הקשר כדי שהצ'אט ידע על מה מדובר. itemId/source
      // יכולים להיות null (audit "אובדן הקשר", 2026-10-19) — ממצא בלי פריט Monday, כמו התחייבות
      // (ר' IncomingAboutContext ב-loopReply.ts). findingKey הוא היחיד שחובה תמיד.
      let about: IncomingAboutContext | undefined;
      const a = body.about as Record<string, unknown> | undefined;
      if (
        a &&
        typeof a.findingKey === "string" &&
        (a.itemId === null || a.itemId === undefined || typeof a.itemId === "string") &&
        (a.source === null || a.source === undefined || a.source === "general" || a.source === "project_stage")
      ) {
        about = {
          itemId: typeof a.itemId === "string" ? a.itemId : null,
          source: a.source === "general" || a.source === "project_stage" ? a.source : null,
          findingKey: a.findingKey,
          taskName: typeof a.taskName === "string" ? a.taskName : undefined,
          // תאריך היעד הידוע מרגע יצירת הפנייה — לא קריאת Monday נוספת. ה-UI מעביר אותו כמו שקיבל
          // מ-/api/nudges. חסר/לא מחרוזת → null (Policy Engine מטפל כ"לא ידוע", לא מנחש).
          currentDueDateISO: typeof a.currentDueDateISO === "string" ? a.currentDueDateISO : null,
          // אם ההודעה היא תשובה לשאלה/הנחיה של מוטי מתוך Approval — אותו about קיים, לא מנגנון
          // מקביל. runOpsChat בודק את זה לפני הכל (audit 2026-09-14).
          approvalId: typeof a.approvalId === "number" ? a.approvalId : undefined,
          // Rule 4 (EOD Engine, 2026-09-16): מגיע מ-/api/nudges (context.missedCommitment שנקבע
          // ב-followups.ts) — לא מנוחש כאן ולא מטקסט העובד. חסר/לא true → false, לא undefined.
          missedCommitment: a.missedCommitment === true,
        };
      }

      const lastUserMessage = messages[messages.length - 1]!.content;
      const contentHash = hashChatContent(lastUserMessage, about);

      // ניטור ביצועים: מתי run() בפועל התחיל (אחרי המתנה אפשרית ל-dedup claim) — ההפרש מ-serverStart
      // הוא queueWaitMs. נשאר 0 אם run() מעולם לא רץ (dedup החזיר תוצאה cached בלי לקרוא לו).
      let runStartedAt = 0;
      try {
        const { result, cached } = await runDedupedChatTurn(user.key, clientMessageId, session, contentHash, async () => {
          runStartedAt = performance.now();
          const r = await runOpsChat(user, messages, { ...(about ? { about } : {}), session, clientMessageId });
          if (r.actions.length) {
            logger.info({ user: user.key, actions: r.actions }, "עדכוני משימה מהצ'אט");
          }
          appendChatTurn(user.key, session, lastUserMessage, r.reply, r.actions);
          return { ...r, session };
        });
        const serverTotalMs = performance.now() - serverStart;
        recordChatPerfMetricSafe({
          requestId,
          userKey: user.key,
          sessionId: result.session ?? session,
          status: "ok",
          cached,
          tier: result.perf?.tier ?? null,
          fallbackUsed: result.perf?.fallbackUsed ?? false,
          queueWaitMs: runStartedAt ? runStartedAt - serverStart : null,
          serverTotalMs,
          aiTimeMs: result.perf?.aiTimeMs ?? null,
          aiCallCount: result.perf?.aiCallCount ?? null,
          toolTimeMs: result.perf?.toolTimeMs ?? null,
          toolCallCount: result.perf?.toolCallCount ?? null,
        });
        // ניטור ביצועים (2026-10-14, הרחבה) — פירוט per-tool/per-prep-step, כתיבה מרוכזת אחת
        // (טרנזקציה יחידה ב-recordChatPerfStepsSafe) בסוף הבקשה, לא תוך כדי — ר' chatPerfSteps.ts.
        if (result.perf) {
          const steps: ChatPerfStepEntry[] = [
            ...result.perf.prepSteps.map((s) => ({ kind: "prep" as const, name: s.name, durationMs: s.durationMs, ok: s.ok })),
            ...result.perf.toolCalls.map((s) => ({ kind: "tool" as const, name: s.name, durationMs: s.durationMs, ok: s.ok })),
          ];
          recordChatPerfStepsSafe(requestId, steps);
        }
        return send(res, 200, { ...result, requestId });
      } catch (err) {
        const serverTotalMs = performance.now() - serverStart;
        // קוד קצר בלבד (לעולם לא err.message המלא) — ר' chat_perf_metrics.error_code ב-schema.sql.
        const errorCode =
          err instanceof ChatMessageConflictError || err instanceof ChatMessageStillProcessingError
            ? err.code
            : (err as Error).name || "error";
        recordChatPerfMetricSafe({
          requestId,
          userKey: user.key,
          sessionId: session,
          status: "error",
          errorCode,
          cached: false,
          fallbackUsed: false,
          queueWaitMs: runStartedAt ? runStartedAt - serverStart : null,
          serverTotalMs,
        });
        if (err instanceof ChatMessageConflictError) return send(res, 409, { error: err.message, code: err.code, requestId });
        if (err instanceof ChatMessageStillProcessingError) return send(res, 409, { error: err.message, code: err.code, requestId });
        throw err;
      }
    }

    // ניטור ביצועים: הדפדפן מדווח בנפרד (fire-and-forget, אחרי שהתשובה כבר הוצגה) את הזמן הכולל
    // שהוא מדד בשעון המונוטוני שלו (performance.now() בלקוח) — לא מניחים סנכרון עם שעון השרת, רק
    // שומרים את שני הזמנים זה לצד זה לפי requestId. לא AI, לא תוכן — רק מספר אחד.
    if (req.method === "POST" && path === "/api/perf/client") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const body = await readJsonBody(req);
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const clientTotalMs = Number(body.clientTotalMs);
      // ולידציה בסיסית (לא קריפטוגרפית) — רק הגנה מפני ערכים מופרכים (לשונית שנשארה פתוחה
      // דקות ארוכות בין שליחה לתשובה) שיזהמו את ה-percentiles.
      if (!requestId || !Number.isFinite(clientTotalMs) || clientTotalMs < 0 || clientTotalMs > 10 * 60_000) {
        return send(res, 400, { error: "קלט לא תקין" });
      }
      // *Safe (ר' chatPerfMetrics.ts) — swallow על כשל, אין try/catch כאן: זה כבר fire-and-forget
      // מהדפדפן (ר' ui.html), אין טעם גם לזרוק וגם לבלוע באותו endpoint.
      recordClientTimingSafe(requestId, user.key, clientTotalMs);
      return send(res, 200, { ok: true });
    }

    // ניטור ביצועים: סיכום P50/P95 לחלון הזמן האחרון — למוטי/יוכי בלבד (כמו /api/control).
    if (req.method === "GET" && path === "/api/perf/summary") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (!user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "סטטיסטיקות ביצועים — למוטי בלבד" });
      }
      const hoursParam = Number(url.searchParams.get("hours"));
      const sinceHours = Number.isFinite(hoursParam) && hoursParam > 0 && hoursParam <= 24 * 30 ? hoursParam : 24;
      // *Safe — מחזיר summary ריק (200) במקום לזרוק אם השליפה נכשלת.
      return send(res, 200, getChatPerfSummarySafe(sinceHours));
    }

    // ניטור ביצועים (2026-10-14, הרחבה): פירוט שלבים (כלים/הכנה) לבקשה ספציפית לפי requestId —
    // מאפשר לנתח "למה הבקשה הזו הייתה איטית" (ר' /api/perf/summary להצגת ה-requestId הרלוונטי).
    // אותן הרשאות בקרה קיימות (view:all_work) — לא נוסף permission חדש.
    // ⚠️ audit lazy loading (2026-10-14): שורות kind='prep' ו-kind='tool' עבור אותו requestId
    // יכולות לחפוף בזמן (fetchUserOpsTasks נטען lazy, בתוך חלון הזמן של הכלי שצריך אותו) — אל
    // תסכמו prep+tool בהנחה שהן בלתי-חופפות. ר' הסבר מלא ב-schema.sql's chat_perf_steps.
    if (req.method === "GET" && path === "/api/perf/steps") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (!user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "פירוט ביצועים — למוטי בלבד" });
      }
      const requestId = url.searchParams.get("requestId") ?? "";
      if (!requestId || requestId.length > 128) {
        return send(res, 400, { error: "requestId חסר/לא תקין" });
      }
      // *Safe — מחזיר [] (200) במקום לזרוק אם השליפה נכשלת.
      return send(res, 200, { requestId, steps: getChatPerfStepsForRequestSafe(requestId) });
    }

    if (req.method === "GET" && path === "/api/chat/sessions") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      return send(res, 200, { sessions: listSessions(user.key), latest: latestSessionId(user.key) });
    }

    if (req.method === "GET" && path === "/api/chat/session") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const id = url.searchParams.get("id");
      return send(res, 200, {
        messages: getSessionMessages(user.key, !id || id === "legacy" ? null : id),
      });
    }

    if (req.method === "POST" && path === "/api/chat/new") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      return send(res, 200, { session: newSessionId() });
    }

    if (req.method === "POST" && path === "/api/chat/session/delete") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id : "";
      deleteSession(user.key, !id || id === "legacy" ? null : id);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/chat/clear") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      clearChatHistory(user.key);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/task/update") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const body = await readJsonBody(req);
      const result = await updateTask(user, {
        action: String(body.action ?? "") as TaskUpdateAction,
        source: String(body.source ?? "") as OpsTaskSource,
        itemId: String(body.itemId ?? ""),
        label: body.label ? String(body.label) : undefined,
        note: body.note ? String(body.note) : undefined,
      });
      logger.info({ user: user.key, itemId: body.itemId, action: body.action }, "עדכון משימה מהחלונית");
      return send(res, 200, result);
    }

    if (req.method === "GET" && path === "/api/oversight") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (!user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "התצוגה הזו למוטי בלבד" });
      }
      const report = await getOversightReport(user);
      return send(res, 200, report);
    }

    if (req.method === "GET" && path === "/api/control") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (!user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "מנוע הבקרה למוטי בלבד" });
      }
      return send(res, 200, await getControlScan(user));
    }

    // debug/admin — לראות מה ה-Follow-up Engine "זוכר לעשות בהמשך". לא UI לעובדים.
    if (req.method === "GET" && path === "/api/control/followups") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (!user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "למוטי בלבד" });
      }
      const status = url.searchParams.get("status");
      const validStatus =
        status === "pending" || status === "processing" || status === "triggered" || status === "completed" || status === "cancelled"
          ? status
          : undefined;
      return send(res, 200, { followups: listFollowups({ status: validStatus }) });
    }

    if (req.method === "GET" && path === "/api/crm") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (!user.permissions.includes("view:all_work") && !user.permissions.includes("view:finance")) {
        return send(res, 403, { error: "בקרת מכירות וכספים — למוטי ולגולדי" });
      }
      return send(res, 200, await runCrmScan());
    }

    if (req.method === "POST" && path === "/api/control/run") {
      const user = currentUser(req);
      if (!user || !user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "למוטי בלבד" });
      }
      return send(res, 200, await runDailyControlCycle());
    }

    if (req.method === "POST" && path === "/api/weekly/run") {
      const user = currentUser(req);
      if (!user || !user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "למוטי בלבד" });
      }
      return send(res, 200, await buildWeeklyReport());
    }

    if (req.method === "POST" && path === "/api/eod/run") {
      const user = currentUser(req);
      if (!user || !user.permissions.includes("view:all_work")) {
        return send(res, 403, { error: "למוטי בלבד" });
      }
      return send(res, 200, await buildEndOfDaySummary());
    }

    if (req.method === "GET" && path === "/api/commitments") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const all = user.permissions.includes("view:all_work");
      return send(res, 200, {
        commitments: (all ? listOpenCommitments() : listUserCommitments(user.key)).map((c) => ({
          id: c.id,
          toWhom: c.toWhom,
          what: c.what,
          dueDate: c.dueDate,
          project: c.project,
          by: resolveUserByKey(c.createdBy)?.name ?? c.createdBy,
        })),
      });
    }

    // ?unseenOnly=1 — "התראות פעילות" בלבד (listUnseenNotifications, בדיוק מה שהיה לפני הדפדוף):
    // לא כולל שום דבר שסומן נקרא, בלי pagination (הנפח תמיד קטן — ברגע שמטפלים/מסמנים, יורד
    // מכאן). בלי הדגל — העמוד הראשון/הבא של ההיסטוריה המלאה (נקראות+לא-נקראות), בדיוק כמו קודם.
    // unseenCount תמיד מחושב בנפרד מהעמוד שנטען — זה מה שמזין את הבאדג' בחלונית בשני המצבים.
    if (req.method === "GET" && path === "/api/notifications") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (url.searchParams.get("unseenOnly") === "1") {
        const notifications = listUnseenNotifications(user.key).map(serializeNotification);
        return send(res, 200, { notifications, hasMore: false, unseenCount: notifications.length });
      }
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 50 ? limitParam : 20;
      const beforeParam = Number(url.searchParams.get("before"));
      const beforeId = Number.isFinite(beforeParam) && beforeParam > 0 ? beforeParam : undefined;
      const page = listNotificationsPage(user.key, limit + 1, beforeId);
      const hasMore = page.length > limit;
      const notifications = (hasMore ? page.slice(0, limit) : page).map(serializeNotification);
      return send(res, 200, { notifications, hasMore, unseenCount: listUnseenNotifications(user.key).length });
    }

    if (req.method === "POST" && path === "/api/notifications/seen") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      markNotificationsSeen(user.key);
      return send(res, 200, { ok: true });
    }

    // סימון נקרא פר-התראה בודדת — לא משפיע על שום התראה אחרת (markNotificationSeenById בודק
    // id+user_key יחד). "טיפול בשיחה" (endpoint-ים אחרים למטה) לא קורא לזה — מצב-קריאה ומצב-טיפול
    // נפרדים בכוונה.
    const notifSeenMatch = path.match(/^\/api\/notifications\/(\d+)\/seen$/);
    if (notifSeenMatch && req.method === "POST") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const ok = markNotificationSeenById(user.key, Number(notifSeenMatch[1]));
      return send(res, 200, { ok });
    }

    // פניות יזומות פתוחות של העובד — ה-UI מרנדר אותן כבועות צ'אט של העוזר.
    if (req.method === "GET" && path === "/api/nudges") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      return send(res, 200, {
        nudges: listUnseenNudges(user.key).map((n) => ({
          id: n.id,
          body: n.body,
          findingKey: n.findingKey,
          itemId: n.itemId,
          source: n.itemSource,
          mondayUrl: n.itemId && n.itemSource ? mondayItemUrl(n.itemId, n.itemSource as OpsTaskSource) : null,
          taskName: (n.context as { taskName?: string } | null)?.taskName ?? null,
          currentDueDateISO: (n.context as { currentDueDateISO?: string | null } | null)?.currentDueDateISO ?? null,
          // אם זו שאלה/הנחיה של מוטי (kind=approval_instruction) — approvalId מגיע דרך about,
          // בדיוק כמו itemId/findingKey. n.itemId/n.findingKey כבר קיימים למעלה מהשורה עצמה.
          approvalId: (n.context as { approvalId?: number } | null)?.approvalId ?? null,
          // Rule 4 (EOD Engine, 2026-09-16) — נקבע ב-followups.ts (processEndOfDayCheck/
          // processNoResponseReminder), לא כאן. ה-UI מעביר את זה חזרה כמו שהוא ב-about.
          missedCommitment: (n.context as { missedCommitment?: boolean } | null)?.missedCommitment === true,
          createdAt: n.createdAt,
        })),
      });
    }

    // מערכת האישורים למוטי — persistent (manager_approvals), לא רק notification.
    // גנרי לפי kind — "deferral" ו-"cancellation" ממומשים (audit 2026-09-17/20, approvalActions.ts).
    if (req.method === "GET" && path === "/api/approvals") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      if (!user.permissions.includes("approve:sensitive")) {
        return send(res, 403, { error: "רק מוטי יכול לראות בקשות אישור" });
      }
      // כרטיס מוטי צריך גם את היסטוריית ההודעות (שאלה/תשובה) — לא רק את שדות ה-Approval עצמו.
      const approvals = listApprovalsForManager(user.key).map((a) => ({ ...a, messages: listApprovalMessages(a.id) }));
      return send(res, 200, { approvals });
    }

    const approvalMatch = path.match(/^\/api\/approvals\/(\d+)\/(approve|reject|instruction)$/);
    if (approvalMatch && req.method === "POST") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      const id = Number(approvalMatch[1]);
      const action = approvalMatch[2];
      const body = await readJsonBody(req);
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;

      const result =
        action === "approve"
          ? await approveApproval(user, id, note)
          : action === "reject"
            ? await rejectApproval(user, id, note)
            : await giveApprovalInstruction(user, id, String(body.instruction ?? ""));

      logger.info({ user: user.key, approvalId: id, action, ok: result.ok }, "הכרעת אישור");
      if (!result.ok) {
        const httpStatus: Record<string, number> = {
          not_found: 404,
          forbidden: 403,
          self_approval: 403,
          already_decided: 409,
          not_awaiting_reply: 409,
          unsupported_kind: 400,
          execution_failed: 502,
          bad_request: 400,
        };
        return send(res, httpStatus[result.code] ?? 400, { error: result.message, code: result.code, approval: result.approval ?? null });
      }
      return send(res, 200, { ok: true, approval: result.approval });
    }

    // SSE — דחיפת פנייה יזומה / בקשת אישור / החלטה, בזמן אמת כשהחלון פתוח.
    if (req.method === "GET" && path === "/api/events") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      const unsubNudge = subscribeNudges((n) => {
        if (n.userKey !== user.key) return;
        const mondayUrl = n.itemId && n.itemSource ? mondayItemUrl(n.itemId, n.itemSource as OpsTaskSource) : null;
        res.write(`event: nudge\ndata: ${JSON.stringify({ ...n, mondayUrl })}\n\n`);
      });
      // approval_request → כרטיס "נדרש אישור" חדש למוטי; approval_reply → תשובת עובד על כרטיס
      // קיים (מעדכן במקום, לא כרטיס נוסף); כל קינד אחר → רענון שקט של באנר ההתראות.
      const unsubNotif = subscribeNotifications((n) => {
        if (n.userKey !== user.key) return;
        const eventName = n.kind === "approval_request" ? "approval" : n.kind === "approval_reply" ? "approval_update" : "notification";
        const mondayUrl = n.itemId && n.itemSource ? mondayItemUrl(n.itemId, n.itemSource as OpsTaskSource) : null;
        res.write(`event: ${eventName}\ndata: ${JSON.stringify({ ...n, mondayUrl })}\n\n`);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsubNudge();
        unsubNotif();
      });
      return; // התגובה נשארת פתוחה
    }

    return send(res, 404, { error: "לא נמצא" });
  } catch (err) {
    logger.error(err, `בקשת ${path} נכשלה`);
    return send(res, 500, { error: (err as Error).message || "שגיאת שרת" });
  }
});

function publicUser(user: IdentifiedUser) {
  return {
    key: user.key,
    name: user.name,
    role: user.role,
    roleDescription: user.roleDescription,
    canOversee: user.permissions.includes("view:all_work"),
    canFinance: user.permissions.includes("view:finance"),
    canApprove: user.permissions.includes("approve:sensitive"),
    canUpdate: user.permissions.includes("task:update_own") && !!user.mondayUserId,
    hasMondayTasks: !!user.mondayUserId,
  };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

// פעימת לב — כל דקה, כדי ש-/health (ותהליכים אחרים) ידעו ש-ops-window חי.
recordHeartbeat("ops-window", `pid ${process.pid}`);
setInterval(() => {
  try {
    recordHeartbeat("ops-window", `pid ${process.pid}`);
  } catch (err) {
    logger.error(err, "כתיבת heartbeat נכשלה");
  }
}, 60_000).unref();

// שחזור חד-פעמי אחרי קריסה/ריסטרט — לא scheduler, רק תיקון מצבי-ביניים תקועים (Audit 2026-09-14/15).
{
  const recovered = recoverStuckApprovals();
  if (recovered > 0) {
    logger.warn(`אישורים ששוחזרו אחרי הפעלה מחדש (היו תקועים ב-'approving'): ${recovered}`);
  }
  const recoveredFollowups = recoverStuckFollowups();
  if (recoveredFollowups > 0) {
    logger.warn(`follow-ups ששוחזרו אחרי הפעלה מחדש (היו תקועים ב-'processing'): ${recoveredFollowups}`);
  }
  // audit שלב ה: chat_message_dedup תקוע ב-'processing' משרת קודם שקרס — לא "עדיין רץ" באמת.
  const recoveredChatClaims = recoverStuckChatMessageClaims();
  if (recoveredChatClaims > 0) {
    logger.warn(`הודעות צ'אט ששוחזרו אחרי הפעלה מחדש (היו תקועות ב-'processing'): ${recoveredChatClaims}`);
  }
}

startScheduler();

server.listen(PORT, () => {
  logger.info(`העוזר התפעולי עלה. מקומי: http://localhost:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) logger.info(`ברשת המשרד: ${lan.join(" · ")}`);
  logger.info(
    REQUIRE_ACCESS_LINK
      ? "כניסה: קישור אישי בלבד (npm run links). מסך בחירת השם מכובה."
      : "כניסה: בחירת שם או קישור אישי. להפעלת קישור-בלבד — REQUIRE_ACCESS_LINK=true.",
  );
});
