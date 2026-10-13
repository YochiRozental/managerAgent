/**
 * מוכיח שהבידוד חוסם רשת וסודות — לא רק fetch.
 * כל יעד כאן הוא example.invalid (TLD שמור שלעולם לא נפתר) — גם אם החסימה הייתה נשברת, שום
 * מערכת אמיתית לא הייתה מקבלת בקשה. אין כאן בדיקות Live.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Gaxios } from "gaxios";
import { GraphQLClient } from "graphql-request";
import { describe, expect, inject, it } from "vitest";
import * as guard from "../setup/networkGuard.js";
const { NETWORK_BLOCKED } = guard;
import { DUMMY_SECRET } from "../setup/envIsolation.js";

const TARGET = "example.invalid";

// הקובץ הזה מנסה לגשת לרשת בכוונה — פטור מבדיקת "אסור לנסות" של tests/setup/isolate.ts
(globalThis as { allowNetworkProbes?: boolean }).allowNetworkProbes = true;

// משטח את שרשרת ה-cause של שגיאה (SDKים עוטפים את השגיאה המקורית)
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 8; i++) {
    parts.push(String((cur as Error).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

// http/https: החסימה זורקת סינכרונית או מגיעה כאירוע error — שתי הדרכים תקינות
function requestOutcome(mod: typeof http | typeof https, url: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const req = mod.request(url, () => resolve("CONNECTED"));
      req.on("error", (e) => resolve(errorChain(e)));
      req.end();
    } catch (e) {
      resolve(errorChain(e));
    }
  });
}

describe("חסימת רשת — מודולי Node", () => {
  it("net.connect ל-TCP חיצוני נחסם", () => {
    expect(() => net.connect({ host: TARGET, port: 443 })).toThrow(NETWORK_BLOCKED);
  });
  it("net.connect ל-localhost נחסם (גם שרת מקומי שרץ לא נגיש)", () => {
    expect(() => net.connect(3001, "127.0.0.1")).toThrow(NETWORK_BLOCKED);
  });
  it("tls.connect נחסם", () => {
    expect(() => tls.connect({ host: TARGET, port: 443 })).toThrow(NETWORK_BLOCKED);
  });
  it("http.request נחסם", async () => {
    expect(await requestOutcome(http, `http://${TARGET}/`)).toContain(NETWORK_BLOCKED);
  });
  it("https.request נחסם", async () => {
    expect(await requestOutcome(https, `https://${TARGET}/`)).toContain(NETWORK_BLOCKED);
  });
  it("fetch גלובלי נחסם", () => {
    expect(() => fetch(`https://${TARGET}/`)).toThrow(NETWORK_BLOCKED);
  });
  it("WebSocket מובנה (undici) נחסם ע\"י ה-guard (לא סתם כשל DNS)", async () => {
    const before = guard.blockedAttempts;
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`wss://${TARGET}/`);
      ws.addEventListener("open", () => resolve("OPEN"));
      ws.addEventListener("error", () => resolve("ERROR"));
      setTimeout(() => resolve("TIMEOUT"), 5000);
    });
    expect(outcome).toBe("ERROR");
    expect(guard.blockedAttempts).toBeGreaterThan(before);
  });
});

describe("חסימת רשת — SDKים שהקוד משתמש בהם", () => {
  it("Anthropic SDK נחסם", async () => {
    const client = new Anthropic({ apiKey: DUMMY_SECRET, baseURL: `https://${TARGET}`, maxRetries: 0 });
    const err = await client.messages
      .create({ model: "x", max_tokens: 1, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(errorChain(err)).toContain(NETWORK_BLOCKED);
  });
  it("OpenAI SDK נחסם", async () => {
    const client = new OpenAI({ apiKey: DUMMY_SECRET, baseURL: `https://${TARGET}`, maxRetries: 0 });
    const err = await client.chat.completions.create({ model: "x", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(errorChain(err)).toContain(NETWORK_BLOCKED);
  });
  it("graphql-request (התעבורה של Monday SDK) נחסם", async () => {
    const err = await new GraphQLClient(`https://${TARGET}/v2`).request("{ me { id } }").catch((e: unknown) => e);
    expect(errorChain(err)).toContain(NETWORK_BLOCKED);
  });
  it("gaxios (התעבורה של googleapis) נחסם", async () => {
    const err = await new Gaxios().request({ url: `https://${TARGET}/`, retry: false }).catch((e: unknown) => e);
    expect(errorChain(err)).toContain(NETWORK_BLOCKED);
  });
});

describe("בידוד סודות", () => {
  it(".env לא נטען — DOTENV_CONFIG_PATH מצביע לקובץ שלא קיים בתוך ה-temp", () => {
    const p = process.env.DOTENV_CONFIG_PATH!;
    expect(p.startsWith(inject("testTmpRoot"))).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
    expect(path.basename(p)).not.toBe(".env");
  });
  it("src/config/env.ts מקבל רק ערכי דמה", async () => {
    const { env } = await import("../../src/config/env.js");
    expect(env.MONDAY_API_TOKEN).toBe(DUMMY_SECRET);
    for (const v of [env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY]) {
      expect(v === undefined || v === DUMMY_SECRET).toBe(true);
    }
    expect(env.ALLOWED_WHATSAPP_JIDS).toBe("");
  });
  it("אין בתהליך משתנה סביבה שנראה כמו סוד עם ערך אמיתי", () => {
    const leaked = Object.entries(process.env)
      .filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))
      .filter(([, v]) => v !== DUMMY_SECRET)
      .map(([k]) => k); // שמות בלבד — לעולם לא ערכים
    expect(leaked).toEqual([]);
  });
});
