/**
 * ניהול הפעלה (session) לחלונית — עוגייה חתומה שמכילה את מפתח המשתמש בלבד.
 *
 * שלב 1: אין סיסמאות. העובד בוחר את שמו / מזין מייל, והמערכת מזהה אותו מול ספר הצוות.
 * זה מספיק לכלי פנימי ברשת סגורה. לפני חשיפה לאינטרנט — צריך אימות אמיתי (סעיף פתוח לשלב 2).
 *
 * העוגייה חתומה ב-HMAC כדי שלא ניתן לזייף זהות ע"י עריכת הערך בדפדפן.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../utils/logger.js";

const SECRET =
  process.env.SESSION_SECRET ??
  (() => {
    logger.warn("SESSION_SECRET לא הוגדר — משתמש במפתח פיתוח קבוע. חובה להגדיר בשרת אמיתי.");
    return "dev-only-insecure-secret-change-me";
  })();

const COOKIE_NAME = "ops_session";
const MAX_AGE_SEC = 60 * 60 * 12; // 12 שעות

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("base64url");
}

export function createSessionCookie(userKey: string): string {
  const payload = `${userKey}.${Date.now()}`;
  const token = `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** מחזיר את מפתח המשתמש מהעוגייה, או null אם אין / לא תקין / פג תוקף. */
export function readSession(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;

  const token = raw.slice(COOKIE_NAME.length + 1);
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;

  const payload = Buffer.from(payloadB64, "base64url").toString();
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }

  const [userKey, issuedAt] = payload.split(".");
  if (!userKey || !issuedAt) return null;
  if (Date.now() - Number(issuedAt) > MAX_AGE_SEC * 1000) return null;
  return userKey;
}
