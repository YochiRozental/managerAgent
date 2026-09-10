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
import {
  listUnseenNotifications,
  listUnseenNudges,
  markNotificationsSeen,
} from "../db/repositories/notifications.js";
import { subscribeNudges } from "../ops/nudgeBus.js";
import { recordHeartbeat } from "../db/repositories/systemHealth.js";
import { updateTask, type TaskUpdateAction } from "../ops/actions.js";
import { runOpsChat, type ChatMessage } from "../ops/chat.js";
import type { LoopContext } from "../ops/loopReply.js";
import { getControlScan } from "../ops/controlScan.js";
import { runCrmScan } from "../ops/crmScan.js";
import { getEmployeeDashboard } from "../ops/dashboard.js";
import { runDailyControlCycle } from "../ops/escalation.js";
import { getHealth, noteIncident } from "../ops/health.js";
import { getOversightReport } from "../ops/oversight.js";
import { startScheduler } from "../ops/scheduler.js";
import { buildWeeklyReport } from "../ops/weeklyReport.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
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
      // תשובה לפנייה יזומה של הבקרה — ה-UI שולח את הקשר המשימה כדי שהצ'אט ידע על מה מדובר.
      let about: LoopContext | undefined;
      const a = body.about as Record<string, unknown> | undefined;
      if (
        a &&
        typeof a.itemId === "string" &&
        typeof a.findingKey === "string" &&
        (a.source === "general" || a.source === "project_stage")
      ) {
        about = {
          itemId: a.itemId,
          source: a.source,
          findingKey: a.findingKey,
          taskName: typeof a.taskName === "string" ? a.taskName : undefined,
        };
      }
      const result = await runOpsChat(user, messages, about ? { about } : {});
      if (result.actions.length) {
        logger.info({ user: user.key, actions: result.actions }, "עדכוני משימה מהצ'אט");
      }
      appendChatTurn(user.key, session, messages[messages.length - 1]!.content, result.reply, result.actions);
      return send(res, 200, { ...result, session });
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

    if (req.method === "GET" && path === "/api/notifications") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      return send(res, 200, { notifications: listUnseenNotifications(user.key) });
    }

    if (req.method === "POST" && path === "/api/notifications/seen") {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: "לא מחובר" });
      markNotificationsSeen(user.key);
      return send(res, 200, { ok: true });
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
          taskName: (n.context as { taskName?: string } | null)?.taskName ?? null,
          createdAt: n.createdAt,
        })),
      });
    }

    // SSE — דחיפת פנייה יזומה בזמן אמת כשהחלון פתוח.
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
      const unsub = subscribeNudges((n) => {
        if (n.userKey !== user.key) return;
        res.write(`event: nudge\ndata: ${JSON.stringify(n)}\n\n`);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        unsub();
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
