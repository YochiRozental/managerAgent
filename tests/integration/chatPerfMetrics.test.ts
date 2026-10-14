/**
 * ניטור ביצועים (2026-10-14) — בדיקה ממוקדת מקצה-לקצה (runOpsChat) + בדיקת-מקור ל-wiring
 * ב-server/index.ts (בדיוק הטכניקה ב-followups.test.ts #11 — לא מרימים שרת HTTP אמיתי, server/
 * index.ts הוא מודול עם side-effects בטעינה ברמת import, אז מאמתים את הקוד כטקסט).
 *
 * READ-ONLY מול Monday (fetchUserOpsTasks/getProjectNextAction/matchProjectsByQuery מדומים —
 * בדיוק tests/integration/attendanceIncident1013.test.ts). אפס קריאת AI אמיתית — _runModel מוזרק.
 */

import "dotenv/config";
import fs from "node:fs";
import { vi } from "vitest";

vi.mock(import("../../src/integrations/monday/opsRead.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUserOpsTasks: async () => [], getProjectNextAction: async () => null, matchProjectsByQuery: () => [] };
});

import { resolveUserByKey } from "../../src/identity/index.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { RunModelParams } from "../../src/ai/providers/types.js";
import { check } from "../helpers/check.js";

const dov = resolveUserByKey("dov")!;
const msg = (text: string): ChatMessage[] => [{ role: "user", content: text }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_CONFIG = { fast: { provider: "anthropic" as const, model: "test-fast" }, smart: { provider: "anthropic" as const, model: "test-smart" }, costLogging: false };

function scriptedModel(scriptByModel: Record<string, { text?: string; delayMs?: number }[]>): RunModelFn {
  const cursor: Record<string, number> = {};
  const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
  return async (params: RunModelParams) => {
    const script = scriptByModel[params.model] ?? [{ text: "x" }];
    const i = cursor[params.model] ?? 0;
    cursor[params.model] = i + 1;
    const step = script[Math.min(i, script.length - 1)]!;
    if (step.delayMs) await sleep(step.delayMs);
    return { text: step.text ?? "", toolCalls: [], assistantContent: [{ type: "text" as const, text: step.text ?? "" }], usage };
  };
}

async function run() {
  // ── 1: תשובה פשוטה ב-FAST — perf.attempts=1, aiCallCount=1, aiTimeMs>0 ─────────────────────
  {
    const fn = scriptedModel({ "test-fast": [{ text: "בוצע", delayMs: 15 }] });
    const result = await runOpsChat(dov, msg("עדכן שסיימתי את המשימה"), {
      session: "perf-s1",
      clientMessageId: "perf-cmid-1",
      _runModel: fn,
      _config: TEST_CONFIG,
    });
    check("1a. perf קיים", !!result.perf);
    check("1b. attempts=1 (אין fallback)", result.perf?.attempts === 1, String(result.perf?.attempts));
    check("1c. aiCallCount=1", result.perf?.aiCallCount === 1, String(result.perf?.aiCallCount));
    check("1d. aiTimeMs>=10 (שעון מונוטוני אמיתי, לא 0)", (result.perf?.aiTimeMs ?? 0) >= 10, String(result.perf?.aiTimeMs));
    check("1e. toolCallCount=0 (אין כלים בסבב הזה)", result.perf?.toolCallCount === 0);
    check("1f. tier=fast", result.perf?.tier === "fast");
    check("1g. fallbackUsed=false", result.perf?.fallbackUsed === false);
  }

  // ── 2: FAST מחזיר טקסט ריק (נכשל, בלי tool_use) → fallback ל-SMART → perf מצטבר על שני הניסיונות ─
  {
    const fn = scriptedModel({
      "test-fast": [{ text: "", delayMs: 10 }],
      "test-smart": [{ text: "הבנתי, מעדכן", delayMs: 10 }],
    });
    // הודעה שמנותבת ל-FAST (לא תואמת למילות-מפתח אנליטיות/בקרה-על — ר' src/ai/models.ts) —
    // כדי לבדוק את מסלול ה-fallback בעצמו, לא את בחירת ה-router.
    const result = await runOpsChat(dov, msg("תעדכן שהתחלתי לעבוד על ההגשה"), {
      session: "perf-s2",
      clientMessageId: "perf-cmid-2",
      _runModel: fn,
      _config: TEST_CONFIG,
    });
    check("2a. fallbackUsed=true", result.perf?.fallbackUsed === true);
    check("2b. aiCallCount=2 (אחת fast + אחת smart)", result.perf?.aiCallCount === 2, String(result.perf?.aiCallCount));
    check("2c. aiTimeMs>=15 (סכום שני הניסיונות, לא רק האחרון)", (result.perf?.aiTimeMs ?? 0) >= 15, String(result.perf?.aiTimeMs));
    check("2d. tier=smart (ה-tier האחרון שהורץ בפועל)", result.perf?.tier === "smart");
  }

  // ── 3: בלי mondayUserId → אין AI כלל → perf=undefined (לא 0 מזויף) ──────────────────────────
  {
    const noMonday = { ...dov, mondayUserId: null };
    const result = await runOpsChat(noMonday, msg("שלום"), { session: "perf-s3" });
    check("3a. perf לא קיים (אין מדידה לבקשה שלא הפעילה AI)", result.perf === undefined);
    check("3b. עדיין מחזיר תשובה תקינה", result.reply.length > 0);
  }

  // ── 4: wiring ב-server/index.ts — requestId, *Safe wrappers, endpoints קיימים בקוד ──────────
  {
    const serverSrc = fs.readFileSync(new URL("../../src/server/index.ts", import.meta.url), "utf-8");
    check("4a. /api/chat מייצר requestId לכל בקשה", /randomUUID\(\)/.test(serverSrc));
    // audit 2026-10-14 (תיקון): /api/chat קורא רק לגרסת ה-*Safe (swallow על כשל) — לא לגרסה
    // הגולמית, שכשל בה היה (לפני התיקון) ממיר תשובה מוצלחת ל-500 כש-ה-catch הכללי תפס אותו.
    check("4b. /api/chat קורא ל-recordChatPerfMetricSafe (לא לגרסה הגולמית)", /recordChatPerfMetricSafe\(/.test(serverSrc));
    check("4b2. אין קריאה ל-recordChatPerfMetric הגולמי (בלי Safe) מ-server/index.ts", !/recordChatPerfMetric\(/.test(serverSrc));
    check("4b3. אין קריאה ל-recordClientTiming/getChatPerfSummary הגולמיים (בלי Safe)", !/recordClientTiming\(|getChatPerfSummary\(/.test(serverSrc));
    check("4c. מודד שעון מונוטוני (performance.now()) ולא Date.now() למדידת משך", /performance\.now\(\)/.test(serverSrc));
    check("4d. endpoint לדיווח זמן-דפדפן קיים וקורא לגרסה הבטוחה", (() => {
      const idx = serverSrc.indexOf('"/api/perf/client"');
      if (idx < 0) return false;
      return /recordClientTimingSafe\(/.test(serverSrc.slice(idx, idx + 1000));
    })());
    check("4e. endpoint סיכום P50/P95 קיים, מוגן view:all_work, וקורא לגרסה הבטוחה", (() => {
      const idx = serverSrc.indexOf('"/api/perf/summary"');
      if (idx < 0) return false;
      const block = serverSrc.slice(idx, idx + 700);
      return /view:all_work/.test(block) && /403/.test(block) && /getChatPerfSummarySafe\(/.test(block);
    })());
    check("4f. requestId מוחזר ללקוח בתשובת /api/chat (לקישור לדיווח הדפדפן)", /\.\.\.result, requestId/.test(serverSrc));
  }

  // ── 5: schema.sql — אין שום עמודת תוכן/פרומפט/טוקן בטבלת המדדים ───────────────────────────
  {
    const schemaSrc = fs.readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf-8");
    const idx = schemaSrc.indexOf("CREATE TABLE IF NOT EXISTS chat_perf_metrics");
    const tableBlock = idx >= 0 ? schemaSrc.slice(idx, schemaSrc.indexOf(");", idx) + 2) : "";
    check("5a. הטבלה קיימת ב-schema", tableBlock.length > 0);
    check(
      "5b. אין עמודות content/message/prompt/token/key בטבלה",
      !/\bcontent\b|\bmessage\b|\bprompt\b|\btoken\b|\bapi_key\b/i.test(tableBlock),
      tableBlock,
    );
  }

  // ── 6: הגרסאות ה"בטוחות" עצמן (audit 2026-10-14) — swallow כשל אמיתי, לא רק בתיאוריה ────────
  {
    const { db } = await import("../../src/db/db.js");
    const {
      recordChatPerfMetricSafe,
      recordClientTimingSafe,
      getChatPerfSummarySafe,
    } = await import("../../src/db/repositories/chatPerfMetrics.js");

    // 6a: duplicate PRIMARY KEY (request_id) → הגרסה הגולמית הייתה זורקת UNIQUE constraint;
    // ה-Safe בולעת ולא זורקת, ושורת ה-DB נשארת כמו שהיתה (לא עודכנה).
    db.prepare(
      `INSERT INTO chat_perf_metrics (request_id, user_key, status, cached, fallback_used, server_total_ms)
       VALUES ('perftest-dup', 'dov', 'ok', 0, 0, 111)`,
    ).run();
    let threw6a = false;
    try {
      recordChatPerfMetricSafe({ requestId: "perftest-dup", userKey: "dov", sessionId: null, status: "ok", cached: false, fallbackUsed: false, serverTotalMs: 999 });
    } catch {
      threw6a = true;
    }
    check("6a. recordChatPerfMetricSafe לא זורקת על duplicate request_id (UNIQUE constraint)", !threw6a);
    const row6a = db.prepare(`SELECT server_total_ms FROM chat_perf_metrics WHERE request_id = 'perftest-dup'`).get() as { server_total_ms: number };
    check("6a2. השורה המקורית לא נדרסה (ה-insert הכושל לא השפיע)", row6a.server_total_ms === 111);
    db.prepare(`DELETE FROM chat_perf_metrics WHERE request_id = 'perftest-dup'`).run();

    // 6b: בינד לא-חוקי (undefined) ל-UPDATE → node:sqlite זורק TypeError ברמת ה-binding;
    // ה-Safe בולעת. בדיקת-עומק (לא חלק מהזרימה הרגילה — /api/chat כבר מוודא Number.isFinite
    // קודם — אבל מגינה גם אם קריאה עתידית תעקוף את הוולידציה הזו).
    let threw6b = false;
    try {
      recordClientTimingSafe(undefined as unknown as string, "dov", 100);
    } catch {
      threw6b = true;
    }
    check("6b. recordClientTimingSafe לא זורקת על קלט לא-חוקי ברמת ה-binding", !threw6b);

    // 6c: הטבלה "נעלמת" (DROP) → getChatPerfSummary הגולמית הייתה זורקת "no such table";
    // ה-Safe מחזירה summary ריק (200-שווה-ערך), לא זורקת. משחזרים את הטבלה בסוף (try/finally)
    // כדי לא להשפיע על שאר קובץ הבדיקות.
    const createTableSql = fs
      .readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf-8")
      .match(/CREATE TABLE IF NOT EXISTS chat_perf_metrics[\s\S]*?\);/)![0];
    let threw6c = false;
    let summary6c: Awaited<ReturnType<typeof getChatPerfSummarySafe>> | null = null;
    try {
      db.exec(`DROP TABLE chat_perf_metrics`);
      try {
        summary6c = getChatPerfSummarySafe(24);
      } catch {
        threw6c = true;
      }
    } finally {
      db.exec(createTableSql);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_perf_created ON chat_perf_metrics (created_at)`);
    }
    check("6c. getChatPerfSummarySafe לא זורקת כש-הטבלה חסרה", !threw6c);
    check("6c2. מחזירה סיכום ריק תקין-מבנית (count=0, לא זורקת/לא undefined)", summary6c?.server.count === 0 && summary6c?.totalRequests === 0);
  }
}

await run();
