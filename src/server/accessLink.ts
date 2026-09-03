/**
 * קישור כניסה אישי לכל עובד ("magic link").
 *
 * כל אחד מקבל URL משלו: https://<host>/?t=<token>. פתיחת הקישור מזהה אותו ומכניסה אותו ישירות —
 * בלי לבחור שם מרשימה ובלי סיסמה. מתאים למכשירים כשרים (שומרים סימנייה).
 *
 * ה-token דטרמיניסטי: HMAC של מפתח המשתמש עם ACCESS_SECRET. אותו קישור עובד תמיד; מבטלים את כל
 * הקישורים בבת אחת ע"י החלפת ACCESS_SECRET. שונה מ-SESSION_SECRET כדי שאפשר לסובב כל אחד לחוד.
 *
 * REQUIRE_ACCESS_LINK=true — מכבה את מסך בחירת השם ואת /api/login, ומחייב קישור אישי (מומלץ בפרודקשן).
 */

import "dotenv/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveUserByKey, TEAM_DIRECTORY } from "../identity/index.js";
import { logger } from "../utils/logger.js";

const ACCESS_SECRET =
  process.env.ACCESS_SECRET ??
  (() => {
    logger.warn("ACCESS_SECRET לא הוגדר — משתמש במפתח פיתוח קבוע. חובה להגדיר בשרת אמיתי.");
    return "dev-only-insecure-access-secret";
  })();

export const REQUIRE_ACCESS_LINK = (process.env.REQUIRE_ACCESS_LINK ?? "").toLowerCase() === "true";

function sign(value: string): string {
  return createHmac("sha256", ACCESS_SECRET).update(value).digest("base64url");
}

export function makeAccessToken(userKey: string): string {
  return `${Buffer.from(userKey).toString("base64url")}.${sign(userKey)}`;
}

/** מחזיר את מפתח המשתמש אם ה-token תקין ומזוהה בספר הצוות, אחרת null. */
export function verifyAccessToken(token: string): string | null {
  const [keyB64, sig] = token.split(".");
  if (!keyB64 || !sig) return null;
  const userKey = Buffer.from(keyB64, "base64url").toString();
  const expected = sign(userKey);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  return resolveUserByKey(userKey) ? userKey : null;
}

export function accessLinkFor(userKey: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/?t=${makeAccessToken(userKey)}`;
}

/** כל הקישורים האישיים — למסך ה-CLI (npm run links). */
export function allAccessLinks(baseUrl: string): { name: string; key: string; link: string }[] {
  return TEAM_DIRECTORY.map((m) => ({ name: m.name, key: m.key, link: accessLinkFor(m.key, baseUrl) }));
}
