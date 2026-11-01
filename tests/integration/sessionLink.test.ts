/**
 * כניסה דרך קישור אישי קבוע + session של 30 יום (2026-11-01).
 *
 * היה: אחרי הכניסה ה-UI מחק את ה-token מהכתובת, וה-session פג אחרי 12 שעות בלי חידוש — רענון (F5)
 * למחרת הציג "פנה ליוכי לקישור חדש". עכשיו: הקישור הקבוע נשאר בסימנייה, השרת מחליף אותו ב-session
 * ומפנה לכתובת נקייה, ה-session מתחדש בשימוש, וקישור שמור מתחבר שוב אחרי פקיעה.
 * בלי רשת/Monday — DB זמני מבודד בלבד (tests/setup).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/db.js";
import { makeAccessToken, reissueAccessLink, verifyAccessToken } from "../../src/server/accessLink.js";
import { handleRoot, isSecureRequest, renewalCookie } from "../../src/server/authFlow.js";
import {
  SESSION_MAX_AGE_SEC,
  clearSessionCookie,
  createSessionCookie,
  readSession,
  readSessionInfo,
} from "../../src/server/session.js";

const DAY = 24 * 60 * 60 * 1000;
const cookieOf = (setCookie: string) => setCookie.split(";")[0]; // "ops_session=..." — מה שהדפדפן שולח חזרה
const params = (q: string) => new URLSearchParams(q);

/** מדמה פתיחת הקישור האישי → מחזיר את ה-Set-Cookie שהדפדפן ישמור. */
function loginViaLink(userKey: string, secure = false): string {
  const r = handleRoot(params(`t=${makeAccessToken(userKey)}`), secure);
  if (r.kind !== "redirect" || !r.headers["Set-Cookie"]) throw new Error("הקישור לא יצר session");
  return r.headers["Set-Cookie"];
}

describe("כניסה מהקישור האישי", () => {
  it("token תקין → session + הפניה לכתובת נקייה בלי ה-token", () => {
    const token = makeAccessToken("dov");
    const r = handleRoot(params(`t=${token}`), true);
    expect(r.kind).toBe("redirect");
    if (r.kind !== "redirect") return;
    expect(r.location).toBe("/");
    expect(r.location).not.toContain(token);
    const set = r.headers["Set-Cookie"];
    expect(set).not.toContain(token); // ה-session הוא לא ה-token
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).toMatch(/Secure/);
    expect(set).toContain(`Max-Age=${SESSION_MAX_AGE_SEC}`);
    expect(SESSION_MAX_AGE_SEC).toBe(30 * 24 * 3600);
    expect(r.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(readSession(cookieOf(set))).toBe("dov");
  });

  it("בלי HTTPS אין דגל Secure (פיתוח מקומי), ועם x-forwarded-proto=https יש", () => {
    expect(loginViaLink("dov", false)).not.toMatch(/Secure/);
    expect(loginViaLink("dov", true)).toMatch(/Secure/);
    const https = { "x-forwarded-proto": "https" };
    expect(isSecureRequest(https, "127.0.0.1", undefined)).toBe(true);
    expect(isSecureRequest(https, "::ffff:172.18.0.1", undefined)).toBe(true); // פרוקסי ברשת docker
    expect(isSecureRequest({}, "127.0.0.1", undefined)).toBe(false);
    // כותרת מזויפת מכתובת ציבורית לא נחשבת
    expect(isSecureRequest(https, "8.8.8.8", undefined)).toBe(false);
    expect(isSecureRequest(https, undefined, undefined)).toBe(false);
    // PUBLIC_URL ב-https → תמיד Secure, וכותרת "http" לא מורידה את הדגל
    expect(isSecureRequest({ "x-forwarded-proto": "http" }, "8.8.8.8", "https://manager-agent.gotlib.biz")).toBe(true);
    expect(isSecureRequest({}, undefined, "http://localhost:3001")).toBe(false);
  });

  it("בלי token מגישים את ה-UI (בלי עוגייה, בלי הפניה)", () => {
    const r = handleRoot(params(""), false);
    expect(r.kind).toBe("ui");
    expect(r.headers["Set-Cookie"]).toBeUndefined();
  });
});

describe("רענון, פתיחה מחדש ופקיעה", () => {
  it("F5 וסגירה/פתיחה: אותה עוגייה ממשיכה לזהות את העובד (גם אחרי ימים)", () => {
    const c = cookieOf(loginViaLink("eitan"));
    expect(readSession(c)).toBe("eitan");
    expect(readSessionInfo(c, Date.now() + 20 * DAY)?.userKey).toBe("eitan");
  });

  it("session פג אחרי 30 יום — ואז הקישור השמור מתחבר שוב", () => {
    const c = cookieOf(loginViaLink("ruchama"));
    expect(readSessionInfo(c, Date.now() + 31 * DAY)).toBeNull();
    const again = handleRoot(params(`t=${makeAccessToken("ruchama")}`), false);
    expect(again.kind === "redirect" && again.headers["Set-Cookie"]).toBeTruthy();
  });

  it("חידוש sliding: טרי לא מתחדש, ישן מעל יום מתחדש לאותו עובד, פג לא מתחדש", () => {
    const c = cookieOf(loginViaLink("goldi"));
    expect(renewalCookie(c, false)).toBeNull();
    const renewed = renewalCookie(c, false, Date.now() + 2 * DAY);
    expect(renewed).toBeTruthy();
    expect(readSession(cookieOf(renewed!))).toBe("goldi");
    expect(renewalCookie(c, false, Date.now() + 31 * DAY)).toBeNull();
    expect(renewalCookie(undefined, false)).toBeNull();
  });

  it("יציאה מנקה את העוגייה", () => {
    const out = clearSessionCookie(true);
    expect(out).toMatch(/Max-Age=0/);
    expect(readSession(cookieOf(out))).toBeNull();
  });
});

describe("ניסיון כניסה ללא הרשאה", () => {
  it("token מזויף / פגום / ריק / עובד לא מוכר → הפניה ל-link=invalid ובלי עוגייה", () => {
    const good = makeAccessToken("dov");
    const [keyB64, sig] = good.split(".");
    const forMoti = `${Buffer.from("moti").toString("base64url")}.${sig}`; // חתימה של דוב על המפתח של מוטי
    const unknown = `${Buffer.from("hacker").toString("base64url")}.${sig}`;
    for (const t of [`${keyB64}.AAAA`, forMoti, unknown, "garbage", "a.b.c", "."]) {
      const r = handleRoot(params(`t=${encodeURIComponent(t)}`), false);
      expect(r.kind, t).toBe("redirect");
      if (r.kind === "redirect") {
        expect(r.location).toBe("/?link=invalid");
        expect(r.headers["Set-Cookie"]).toBeUndefined();
      }
    }
    expect(verifyAccessToken(forMoti)).toBeNull();
  });

  it("עוגייה מזויפת / ערוכה / בלי חתימה לא מזהה אף אחד", () => {
    const c = cookieOf(createSessionCookie("dov"));
    const [, sig] = c.slice("ops_session=".length).split(".");
    const forgedPayload = Buffer.from(`moti.${Date.now()}.0`).toString("base64url");
    expect(readSession(`ops_session=${forgedPayload}.${sig}`)).toBeNull();
    expect(readSession(`ops_session=${forgedPayload}`)).toBeNull();
    expect(readSession("ops_session=")).toBeNull();
    expect(readSession(undefined)).toBeNull();
  });

  it("הפרדת משתמשים: כל עוגייה מזהה רק את בעליה", () => {
    const a = cookieOf(loginViaLink("dov"));
    const b = cookieOf(loginViaLink("eitan"));
    expect(readSession(a)).toBe("dov");
    expect(readSession(b)).toBe("eitan");
    expect(readSession(`${a}; other=1`)).toBe("dov");
  });
});

describe("ביטול והנפקה מחדש לעובד בודד", () => {
  it("מבטל את הקישור וה-sessions של העובד בלבד; אחרים לא מושפעים; הקישור החדש עובד", () => {
    const motiToken = makeAccessToken("moti");
    const motiCookie = cookieOf(loginViaLink("moti"));
    const eitanOld = makeAccessToken("eitan");
    const eitanCookie = cookieOf(loginViaLink("eitan"));

    expect(reissueAccessLink("eitan")).toBeGreaterThanOrEqual(1);

    expect(verifyAccessToken(eitanOld)).toBeNull();
    expect(readSession(eitanCookie)).toBeNull();
    const eitanNew = makeAccessToken("eitan");
    expect(eitanNew).not.toBe(eitanOld);
    expect(verifyAccessToken(eitanNew)).toBe("eitan");

    expect(makeAccessToken("moti")).toBe(motiToken);
    expect(verifyAccessToken(motiToken)).toBe("moti");
    expect(readSession(motiCookie)).toBe("moti");

    reissueAccessLink("eitan"); // הנפקה נוספת מבטלת גם את הקישור שהונפק מקודם
    expect(verifyAccessToken(eitanNew)).toBeNull();
  });

  it("עובד לא מוכר נדחה ולא נוצרת שורה", () => {
    expect(() => reissueAccessLink("nobody")).toThrow();
    expect(db.prepare(`SELECT 1 FROM access_link_epochs WHERE user_key = 'nobody'`).get()).toBeUndefined();
  });
});

describe("ה-UI: טיפול ב-401 ואין token בצד לקוח", () => {
  const html = readFileSync(resolve(import.meta.dirname, "../../src/server/ui.html"), "utf8");

  it("אין שמירת token/session ב-localStorage/sessionStorage", () => {
    expect(html).not.toMatch(/(localStorage|sessionStorage)\.setItem\([^)]*(token|session|ops_session)/i);
  });

  it("401 באמצע שימוש מציג מסך כניסה, בלי רענון אוטומטי (אין לולאה)", () => {
    const start = html.indexOf("function sessionLost");
    const fn = html.slice(start, start + 600);
    expect(html).toContain(`r.status === 401 && path !== "/api/session" && path !== "/api/login") sessionLost();`);
    expect(fn).toContain("sessionLostShown");
    expect(fn).not.toMatch(/location\.(reload|href|replace|assign)/);
  });

  it("ה-UI כבר לא מנקה את ה-token בעצמו (השרת מפנה)", () => {
    expect(html).not.toContain(`location.search.includes("t=")`);
  });
});
