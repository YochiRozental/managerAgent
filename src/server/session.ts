/**
 * ניהול הפעלה (session) לחלונית — עוגייה חתומה שמכילה את מפתח המשתמש בלבד.
 *
 * אין סיסמאות: הכניסה היא דרך הקישור האישי (accessLink.ts) או, כשהוא לא חובה, בחירת שם. העוגייה חתומה
 * ב-HMAC כדי שלא ניתן לזייף זהות ע"י עריכת הערך בדפדפן, ונושאת את "דור" הקישור של העובד — הנפקה מחדש של
 * הקישור (accessLink.reissueAccessLink) פוסלת את כל ה-sessions הקיימים של אותו עובד ורק שלו.
 *
 * תוקף 30 יום עם חידוש בשימוש (sliding): בקשה עם session ישן מעל יום מקבלת עוגייה חדשה (shouldRenew).
 */

import "dotenv/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "../utils/logger.js";
import { getAccessEpoch } from "./accessLink.js";

const SECRET =
  process.env.SESSION_SECRET ??
  (() => {
    logger.warn("SESSION_SECRET לא הוגדר — משתמש במפתח פיתוח קבוע. חובה להגדיר בשרת אמיתי.");
    return "dev-only-insecure-secret-change-me";
  })();

const COOKIE_NAME = "ops_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 יום
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000; // מחדשים לכל היותר פעם ביום

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("base64url");
}

function cookieAttrs(secure: boolean, maxAge: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** secure=true מוסיף את דגל Secure (נקבע לפי HTTPS של הבקשה — ר' authFlow.isSecureRequest). */
export function createSessionCookie(userKey: string, secure = false): string {
  const payload = `${userKey}.${Date.now()}.${getAccessEpoch(userKey)}`;
  const token = `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
  return `${COOKIE_NAME}=${token}; ${cookieAttrs(secure, SESSION_MAX_AGE_SEC)}`;
}

export function clearSessionCookie(secure = false): string {
  return `${COOKIE_NAME}=; ${cookieAttrs(secure, 0)}`;
}

export interface SessionInfo {
  userKey: string;
  issuedAt: number;
}

/** מפרש את העוגייה: null אם אין / לא תקינה / פגה / הדור שלה בוטל. */
export function readSessionInfo(cookieHeader: string | undefined, now = Date.now()): SessionInfo | null {
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

  // עוגיות מלפני הדור (שני חלקים) נחשבות דור 0 — ממשיכות לעבוד עד שהדור של העובד יוגדל.
  const [userKey, issuedAtRaw, epochRaw] = payload.split(".");
  if (!userKey || !issuedAtRaw) return null;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || now - issuedAt > SESSION_MAX_AGE_SEC * 1000) return null;
  if (Number(epochRaw ?? 0) !== getAccessEpoch(userKey)) return null;
  return { userKey, issuedAt };
}

/** מחזיר את מפתח המשתמש מהעוגייה, או null אם אין / לא תקין / פג תוקף / בוטל. */
export function readSession(cookieHeader: string | undefined): string | null {
  return readSessionInfo(cookieHeader)?.userKey ?? null;
}

/** האם כדאי להנפיק עוגייה חדשה (חידוש sliding)? */
export function shouldRenew(info: SessionInfo, now = Date.now()): boolean {
  return now - info.issuedAt > RENEW_AFTER_MS;
}
