/**
 * קישור כניסה אישי לכל עובד ("magic link").
 *
 * כל אחד מקבל URL משלו: https://<host>/?t=<token>. פתיחת הקישור מזהה אותו ומכניסה אותו ישירות —
 * בלי לבחור שם מרשימה ובלי סיסמה. מתאים למכשירים כשרים (שומרים סימנייה). השרת מחליף את הקישור ב-session
 * (עוגייה) ומפנה לכתובת נקייה — ה-token לא נשאר בשורת הכתובת (ר' authFlow.ts).
 *
 * ה-token דטרמיניסטי: HMAC של מפתח המשתמש עם ACCESS_SECRET. אותו קישור עובד תמיד; מבטלים את כל
 * הקישורים בבת אחת ע"י החלפת ACCESS_SECRET. שונה מ-SESSION_SECRET כדי שאפשר לסובב כל אחד לחוד.
 *
 * ביטול והנפקה מחדש לעובד בודד: לכל עובד "דור" (epoch) בטבלת access_link_epochs. דור 0 = הקישור המקורי
 * (חתימה על המפתח בלבד, תואם לקישורים שכבר נשלחו). הנפקה מחדש מגדילה את הדור של אותו עובד בלבד →
 * הקישור הישן וכל ה-sessions שלו נפסלים (ה-session נושא את הדור, ר' session.ts); שאר העובדים לא מושפעים.
 *
 * REQUIRE_ACCESS_LINK=true — מכבה את מסך בחירת השם ואת /api/login, ומחייב קישור אישי (מומלץ בפרודקשן).
 */

import "dotenv/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../db/db.js";
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

/** הדור הנוכחי של הקישור האישי של העובד (0 אם מעולם לא הונפק מחדש). */
export function getAccessEpoch(userKey: string): number {
  const row = db.prepare(`SELECT epoch FROM access_link_epochs WHERE user_key = ?`).get(userKey) as
    | { epoch: number }
    | undefined;
  return row?.epoch ?? 0;
}

/** מבטל את הקישור (ואת כל ה-sessions) של עובד אחד ומחזיר את הדור החדש. לא נוגע באף עובד אחר. */
export function reissueAccessLink(userKey: string): number {
  if (!resolveUserByKey(userKey)) throw new Error(`עובד לא מוכר: ${userKey}`);
  db.prepare(
    `INSERT INTO access_link_epochs (user_key, epoch, reissued_at) VALUES (?, 1, ?)
     ON CONFLICT(user_key) DO UPDATE SET epoch = epoch + 1, reissued_at = excluded.reissued_at`,
  ).run(userKey, new Date().toISOString());
  return getAccessEpoch(userKey);
}

// דור 0 חותם על המפתח בלבד (זהה לפורמט המקורי); דור>0 מוסיף מפריד שלא יכול להופיע במפתח.
function signatureInput(userKey: string, epoch: number): string {
  return epoch === 0 ? userKey : `${userKey}\u0000${epoch}`;
}

export function makeAccessToken(userKey: string): string {
  return `${Buffer.from(userKey).toString("base64url")}.${sign(signatureInput(userKey, getAccessEpoch(userKey)))}`;
}

/** מחזיר את מפתח המשתמש אם ה-token תקין ומזוהה בספר הצוות, אחרת null. */
export function verifyAccessToken(token: string): string | null {
  const [keyB64, sig] = token.split(".");
  if (!keyB64 || !sig) return null;
  const userKey = Buffer.from(keyB64, "base64url").toString();
  if (!resolveUserByKey(userKey)) return null;
  const expected = sign(signatureInput(userKey, getAccessEpoch(userKey)));
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  return userKey;
}

export function accessLinkFor(userKey: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/?t=${makeAccessToken(userKey)}`;
}

/** כל הקישורים האישיים — למסך ה-CLI (npm run links). */
export function allAccessLinks(baseUrl: string): { name: string; key: string; link: string }[] {
  return TEAM_DIRECTORY.map((m) => ({ name: m.name, key: m.key, link: accessLinkFor(m.key, baseUrl) }));
}
