/**
 * זרימת הכניסה של החלונית, מופרדת מ-index.ts כדי שאפשר לבדוק אותה בלי להרים שרת.
 *
 *  - GET / ?t=<token>: token תקין → Set-Cookie (session 30 יום) + 302 לכתובת נקייה "/" (ה-token לא נשאר
 *    בשורת הכתובת, בהיסטוריה של העמוד או ב-Referer). token לא תקין/מבוטל → 302 ל-"/?link=invalid"
 *    בלי לגעת בעוגייה. בלי token → מגישים את ה-UI.
 *  - חידוש sliding: כל בקשה עם session תקין ישן מעל יום מקבלת עוגייה חדשה.
 *  - ה-token לעולם לא נכתב ללוג; נרשם רק מפתח המשתמש.
 */

import type { IncomingHttpHeaders } from "node:http";
import { logger } from "../utils/logger.js";
import { verifyAccessToken } from "./accessLink.js";
import { createSessionCookie, readSessionInfo, shouldRenew } from "./session.js";

/** כתובת מקומית/פרטית — פרוקסי על אותו host או ברשת docker (השרת פורסם רק ל-127.0.0.1, ר' docker-compose). */
function isTrustedProxyAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return (
    a === "::1" ||
    /^127\./.test(a) ||
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a)
  );
}

/**
 * האם לסמן את העוגייה Secure. לא סומכים על כותרת שהלקוח יכול לזייף:
 *  1. PUBLIC_URL שמתחיל ב-https:// → תמיד Secure (כותרת לא יכולה להוריד את הדגל).
 *  2. אחרת x-forwarded-proto נחשב רק אם החיבור הגיע מפרוקסי מקומי/פרטי (Caddy / oauth2-proxy), שדורס אותה.
 *     בקשה ישירה מכתובת ציבורית — הכותרת מתעלמים ממנה.
 */
export function isSecureRequest(
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
  publicUrl = process.env.PUBLIC_URL,
): boolean {
  if ((publicUrl ?? "").startsWith("https://")) return true;
  if (!isTrustedProxyAddress(remoteAddress)) return false;
  const proto = headers["x-forwarded-proto"];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim();
  return first === "https";
}

export type RootResult =
  | { kind: "ui"; headers: Record<string, string> }
  | { kind: "redirect"; location: string; headers: Record<string, string> };

/** GET / — ר' תיאור הקובץ. */
export function handleRoot(searchParams: URLSearchParams, secure: boolean): RootResult {
  const token = searchParams.get("t");
  if (!token) return { kind: "ui", headers: { "Referrer-Policy": "no-referrer" } };

  const userKey = verifyAccessToken(token);
  if (!userKey) {
    logger.warn("ניסיון כניסה עם קישור לא תקין או מבוטל");
    return { kind: "redirect", location: "/?link=invalid", headers: { "Referrer-Policy": "no-referrer" } };
  }
  logger.info({ user: userKey }, "כניסה דרך קישור אישי");
  return {
    kind: "redirect",
    location: "/",
    headers: { "Set-Cookie": createSessionCookie(userKey, secure), "Referrer-Policy": "no-referrer" },
  };
}

/** עוגייה חדשה אם ה-session תקין והגיע הזמן לחדש אותו; אחרת null. */
export function renewalCookie(cookieHeader: string | undefined, secure: boolean, now = Date.now()): string | null {
  const info = readSessionInfo(cookieHeader, now);
  return info && shouldRenew(info, now) ? createSessionCookie(info.userKey, secure) : null;
}
