/**
 * ניטור ביצועים (2026-10-14) — src/db/repositories/chatPerfMetrics.ts. DB זמני מבודד
 * (tests/setup/isolate.ts, AGENT_DB_PATH). בודק: insert, עדכון זמן-דפדפן (כולל הגנת user_key),
 * ניקוי (retention), וחישוב P50/P95/avg.
 */

import "dotenv/config";
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../../src/db/db.js";
import {
  recordChatPerfMetric,
  recordClientTiming,
  pruneChatPerfMetrics,
  getChatPerfSummary,
} from "../../src/db/repositories/chatPerfMetrics.js";

function cleanup(): void {
  db.exec(`DELETE FROM chat_perf_metrics WHERE request_id LIKE 'perftest-%'`);
}

beforeEach(() => cleanup());

describe("chatPerfMetrics — רישום וקריאה", () => {
  it("רישום שורה: כל השדות נשמרים ונקראים חזרה", () => {
    recordChatPerfMetric({
      requestId: "perftest-1",
      userKey: "dov",
      sessionId: "s1",
      status: "ok",
      cached: false,
      tier: "fast",
      fallbackUsed: false,
      queueWaitMs: 5,
      serverTotalMs: 120.6,
      aiTimeMs: 80.2,
      aiCallCount: 1,
      toolTimeMs: 10.1,
      toolCallCount: 1,
    });
    const row = db.prepare(`SELECT * FROM chat_perf_metrics WHERE request_id = ?`).get("perftest-1") as Record<string, unknown>;
    expect(row.user_key).toBe("dov");
    expect(row.status).toBe("ok");
    expect(row.server_total_ms).toBe(121); // מעוגל
    expect(row.ai_time_ms).toBe(80);
    expect(row.tool_time_ms).toBe(10);
    expect(row.cached).toBe(0);
    expect(row.fallback_used).toBe(0);
    // בכוונה: אין עמודת תוכן כלשהי בטבלה — אין message/prompt/content בכלל ב-schema
    expect("message" in row).toBe(false);
    expect("content" in row).toBe(false);
  });

  it("שורת שגיאה: error_code נשמר, שדות AI/כלים יכולים להיות null", () => {
    recordChatPerfMetric({
      requestId: "perftest-err",
      userKey: "dov",
      sessionId: null,
      status: "error",
      errorCode: "still_processing",
      cached: false,
      fallbackUsed: false,
      serverTotalMs: 5,
    });
    const row = db.prepare(`SELECT * FROM chat_perf_metrics WHERE request_id = ?`).get("perftest-err") as Record<string, unknown>;
    expect(row.status).toBe("error");
    expect(row.error_code).toBe("still_processing");
    expect(row.ai_time_ms).toBeNull();
  });

  it("עדכון זמן-דפדפן: מצליח כש-user_key תואם, נכשל בשקט (false) כש-לא תואם או לא קיים", () => {
    recordChatPerfMetric({ requestId: "perftest-2", userKey: "dov", sessionId: null, status: "ok", cached: false, fallbackUsed: false, serverTotalMs: 50 });
    expect(recordClientTiming("perftest-2", "dov", 300)).toBe(true);
    const row = db.prepare(`SELECT client_total_ms FROM chat_perf_metrics WHERE request_id = ?`).get("perftest-2") as { client_total_ms: number };
    expect(row.client_total_ms).toBe(300);

    // משתמש אחר לא יכול לעדכן שורה שלא שלו
    expect(recordClientTiming("perftest-2", "eitan", 999)).toBe(false);
    const unchanged = db.prepare(`SELECT client_total_ms FROM chat_perf_metrics WHERE request_id = ?`).get("perftest-2") as { client_total_ms: number };
    expect(unchanged.client_total_ms).toBe(300);

    expect(recordClientTiming("perftest-does-not-exist", "dov", 1)).toBe(false);
  });

  it("ניקוי: מוחק רק שורות ישנות מ-N ימים, לא נוגע בשורות חדשות", () => {
    db.prepare(
      `INSERT INTO chat_perf_metrics (request_id, user_key, status, cached, fallback_used, server_total_ms, created_at)
       VALUES ('perftest-old', 'dov', 'ok', 0, 0, 10, datetime('now', '-40 days'))`,
    ).run();
    recordChatPerfMetric({ requestId: "perftest-new", userKey: "dov", sessionId: null, status: "ok", cached: false, fallbackUsed: false, serverTotalMs: 10 });

    const pruned = pruneChatPerfMetrics(30);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(db.prepare(`SELECT 1 FROM chat_perf_metrics WHERE request_id = 'perftest-old'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM chat_perf_metrics WHERE request_id = 'perftest-new'`).get()).toBeDefined();
  });

  it("סיכום: avg/P50/P95 מחושבים נכון, cached מוחרג מ-server/AI/tool אבל נכלל ב-clientTotal", () => {
    // חמש בקשות "אמיתיות" עם server_total_ms = 100,200,300,400,500 → avg=300, p50=300, p95=500
    const values = [100, 200, 300, 400, 500];
    values.forEach((v, i) => {
      recordChatPerfMetric({
        requestId: `perftest-sum-${i}`,
        userKey: "dov",
        sessionId: null,
        status: "ok",
        cached: false,
        tier: "fast",
        fallbackUsed: false,
        serverTotalMs: v,
        aiTimeMs: v / 2,
        aiCallCount: 1,
        toolTimeMs: 1,
        toolCallCount: 1,
      });
    });
    // שורה אחת cached — לא אמורה להשפיע על server/aiTime/toolTime, אבל כן נכללת בספירה הכוללת
    recordChatPerfMetric({
      requestId: "perftest-sum-cached",
      userKey: "dov",
      sessionId: null,
      status: "ok",
      cached: true,
      fallbackUsed: false,
      serverTotalMs: 1,
    });

    const summary = getChatPerfSummary(24);
    expect(summary.totalRequests).toBe(6);
    expect(summary.cachedCount).toBe(1);
    expect(summary.server.count).toBe(5); // cached מוחרג
    expect(summary.server.avg).toBe(300);
    expect(summary.server.p50).toBe(300);
    expect(summary.server.p95).toBe(500);
  });
});
