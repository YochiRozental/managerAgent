/**
 * ניסוי Prompt Caching (2026-10-14) — חיווט מקצה-לקצה: הדגל + ההגבלה ל-yochi בלבד. דגל ה-env
 * מדומה (mutable, per-test) כדי לבדוק גם flag=on וגם flag=off באותו קובץ בלי תלות בסדר import
 * של קבצי בדיקה אחרים — ר' vi.mock למטה.
 *
 * READ-ONLY מול Monday (fetchUserOpsTasks מדומה). אפס קריאת AI אמיתית — _runModel מוזרק,
 * ובודק בעצמו (לא רק מניח) מה בדיוק הועבר ל-provider.
 */

import "dotenv/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchUserOpsTasksMock } = vi.hoisted(() => ({ fetchUserOpsTasksMock: vi.fn() }));
vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUserOpsTasks: fetchUserOpsTasksMock, getProjectNextAction: async () => null, matchProjectsByQuery: () => [] };
});
// env מדומה (אובייקט חדש אחד, mutable) — chat.ts/prompt.ts מקבלים את *אותו* instance כי כולם
// מייבאים מה-mock הזה; שינוי property עליו תוך-כדי בדיקה נראה לכולם (binding חי, לא snapshot).
vi.mock(import("../../src/config/env.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, env: { ...actual.env } };
});

import { env } from "../../src/config/env.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { RunModelParams, RunModelResult } from "../../src/ai/providers/types.js";

const msg = (text: string): ChatMessage[] => [{ role: "user", content: text }];
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };

function captureParams(): { fn: RunModelFn; calls: RunModelParams[] } {
  const calls: RunModelParams[] = [];
  const fn: RunModelFn = async (params) => {
    calls.push(params);
    return { text: "בוקר טוב גם לך", toolCalls: [], assistantContent: [{ type: "text", text: "בוקר טוב גם לך" }], usage: USAGE } satisfies RunModelResult;
  };
  return { fn, calls };
}

beforeEach(() => {
  fetchUserOpsTasksMock.mockReset();
  fetchUserOpsTasksMock.mockResolvedValue([]);
  env.PROMPT_CACHING_EXPERIMENT_ENABLED = false; // ברירת מחדל — כבוי, כמו בפרודקשן היום
});

describe("ניסוי Prompt Caching — הגבלת flag + משתמש", () => {
  it("flag כבוי (ברירת מחדל) — יוכי *לא* מקבל promptCaching, גם בלי שינוי אחר", async () => {
    const yochi = resolveUserByKey("yochi")!;
    const { fn, calls } = captureParams();
    await runOpsChat(yochi, msg("בוקר טוב"), { session: "s1", clientMessageId: "cmid-1", _runModel: fn, _config: TEST_CONFIG });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptCaching).toBeUndefined();
    expect(typeof calls[0]!.system).toBe("string");
    expect(calls[0]!.system.length).toBeGreaterThan(100); // system עדיין מחרוזת רגילה, לא נגעו בה
  });

  it("flag פעיל + יוכי — promptCaching מועבר, עם cacheableSystem/volatileSystemSuffix תקינים", async () => {
    env.PROMPT_CACHING_EXPERIMENT_ENABLED = true;
    const yochi = resolveUserByKey("yochi")!;
    const { fn, calls } = captureParams();
    await runOpsChat(yochi, msg("בוקר טוב"), { session: "s2", clientMessageId: "cmid-2", _runModel: fn, _config: TEST_CONFIG });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptCaching).toBeDefined();
    expect(calls[0]!.promptCaching!.cacheableSystem.length).toBeGreaterThan(100);
    expect(calls[0]!.promptCaching!.volatileSystemSuffix).toMatch(/^היום .+, השעה \d{2}:\d{2} /);
    // cacheableSystem לא כולל את שורת התאריך (היא ב-volatile בלבד)
    expect(calls[0]!.promptCaching!.cacheableSystem).not.toMatch(/השעה \d{2}:\d{2}/);
  });

  it("flag פעיל + משתמש *אחר* (דוב) — promptCaching לא מועבר, אין שינוי התנהגות", async () => {
    env.PROMPT_CACHING_EXPERIMENT_ENABLED = true;
    const dov = resolveUserByKey("dov")!;
    const { fn, calls } = captureParams();
    await runOpsChat(dov, msg("בוקר טוב"), { session: "s3", clientMessageId: "cmid-3", _runModel: fn, _config: TEST_CONFIG });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptCaching).toBeUndefined();
  });

  it("flag פעיל + יוכי, אבל תשובה דרך fallback FAST→SMART — promptCaching מועבר בשני הניסיונות", async () => {
    env.PROMPT_CACHING_EXPERIMENT_ENABLED = true;
    const yochi = resolveUserByKey("yochi")!;
    const calls: RunModelParams[] = [];
    const fn: RunModelFn = async (params) => {
      calls.push(params);
      if (params.model === "test-fast") return { text: "", toolCalls: [], assistantContent: [], usage: USAGE }; // ריק → נכשל → fallback
      return { text: "בהחלט", toolCalls: [], assistantContent: [{ type: "text", text: "בהחלט" }], usage: USAGE };
    };
    await runOpsChat(yochi, msg("תעדכן שהתחלתי לעבוד על ההגשה"), {
      session: "s4",
      clientMessageId: "cmid-4",
      _runModel: fn,
      _config: TEST_CONFIG,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2); // fast + smart
    for (const c of calls) expect(c.promptCaching).toBeDefined();
  });

  it("לא קוראים ל-fetchUserOpsTasks בכלל (lazy loading עדיין פעיל — הניסוי לא שינה את זה)", async () => {
    env.PROMPT_CACHING_EXPERIMENT_ENABLED = true;
    const yochi = resolveUserByKey("yochi")!;
    const { fn } = captureParams();
    await runOpsChat(yochi, msg("בוקר טוב"), { session: "s5", clientMessageId: "cmid-5", _runModel: fn, _config: TEST_CONFIG });
    expect(fetchUserOpsTasksMock).not.toHaveBeenCalled();
  });
});
