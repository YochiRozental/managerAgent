/**
 * שרת החלונית — מגיש את מנוע שלוש התצוגות + תצוגת הבקרה של מוטי + עדכון משימות, ואת ה-UI עצמו.
 *
 * הרצה:  npm run window   →   http://localhost:3001
 *
 * כל בקשת API עוברת דרך שכבת הזהות: readSession → resolveUserByKey → הרשאות.
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  resolveUserByEmail,
  resolveUserByKey,
  TEAM_DIRECTORY,
  type IdentifiedUser,
} from "../identity/index.js";
import { updateTask, type TaskUpdateAction } from "../ops/actions.js";
import { getEmployeeDashboard } from "../ops/dashboard.js";
import { getOversightReport } from "../ops/oversight.js";
import type { OpsTaskSource } from "../integrations/monday/opsRead.js";
import { logger } from "../utils/logger.js";
import { clearSessionCookie, createSessionCookie, readSession } from "./session.js";

const PORT = Number(process.env.PORT ?? 3001);
const UI_HTML = await readFile(new URL("./ui.html", import.meta.url), "utf8");

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
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return send(res, 200, UI_HTML);
    }

    if (req.method === "GET" && path === "/api/users") {
      // רשימת השמות למסך הכניסה. כלי פנימי — הרשימה לא סודית.
      return send(res, 200, {
        users: TEAM_DIRECTORY.map((m) => ({ key: m.key, name: m.name, role: m.role })),
      });
    }

    if (req.method === "POST" && path === "/api/login") {
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
    canUpdate: user.permissions.includes("task:update_own") && !!user.mondayUserId,
    hasMondayTasks: !!user.mondayUserId,
  };
}

server.listen(PORT, () => {
  logger.info(`חלונית העובד עלתה על http://localhost:${PORT}`);
  logger.info(`משתמשים לכניסה: ${TEAM_DIRECTORY.map((m) => m.name).join(" · ")}`);
});
