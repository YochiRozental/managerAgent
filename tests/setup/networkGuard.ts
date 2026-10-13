/**
 * חסימת רשת לבדיקות אוטומטיות — ברמת ה-socket, לא רק fetch.
 *
 * כל ה-SDKים (Anthropic / OpenAI / Monday / googleapis / Baileys-ws) יוצאים לרשת בסוף דרך
 * net.Socket.prototype.connect — גם http/https, tls.connect, undici (ה-fetch המובנה ו-WebSocket
 * של Node). חוסמים שם כל חיבור TCP (כולל localhost — אין לבדיקות סיבה להגיע לשרת מקומי שרץ),
 * ומשאירים רק חיבורי pipe מקומיים (path) שבהם Vitest עצמו עשוי להשתמש. fetch נחסם גם ישירות,
 * כדי שהכשל יהיה מיידי וברור.
 *
 * לא מכוסה: dgram (UDP) ו-child_process — אף אחד מהם לא משמש את הקוד הנבדק כיום.
 */

import net from "node:net";

export const NETWORK_BLOCKED = "בדיקות אוטומטיות: גישה לרשת חסומה";

let installed = false;

/** כמה ניסיונות חיבור נחסמו — מאפשר לבדיקה להוכיח שהחסימה היא שעצרה, ולא סתם כשל DNS. */
export let blockedAttempts = 0;

export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    const opts = (Array.isArray(first) ? first[0] : first) as { path?: unknown } | string | number | undefined;
    const isPipe = typeof opts === "string" || (typeof opts === "object" && opts !== null && typeof opts.path === "string");
    if (!isPipe) {
      blockedAttempts++;
      throw new Error(`${NETWORK_BLOCKED} (socket)`);
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  globalThis.fetch = (() => {
    blockedAttempts++;
    throw new Error(`${NETWORK_BLOCKED} (fetch)`);
  }) as typeof fetch;
}
