/**
 * ניטור ביצועים (2026-10-14, הרחבה) — src/db/repositories/chatPerfSteps.ts. DB זמני מבודד
 * (tests/setup/isolate.ts, AGENT_DB_PATH). בודק: כתיבה מרוכזת (טרנזקציה אחת), קריאה לפי
 * request_id, ניקוי (retention), והגרסאות ה"בטוחות" (swallow על כשל אמיתי).
 */

import "dotenv/config";
import fs from "node:fs";
import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../../src/db/db.js";
import {
  recordChatPerfSteps,
  recordChatPerfStepsSafe,
  pruneChatPerfSteps,
  getChatPerfStepsForRequest,
  getChatPerfStepsForRequestSafe,
} from "../../src/db/repositories/chatPerfSteps.js";

function cleanup(): void {
  db.exec(`DELETE FROM chat_perf_steps WHERE request_id LIKE 'stepstest-%'`);
}

beforeEach(() => cleanup());

describe("chatPerfSteps — רישום וקריאה", () => {
  it("כתיבה מרוכזת: כמה שלבים (prep+tool) נכתבים בבת אחת ונקראים לפי request_id, בסדר ריצה", () => {
    recordChatPerfSteps("stepstest-1", [
      { kind: "prep", name: "fetch_user_ops_tasks", durationMs: 123.6, ok: true },
      { kind: "tool", name: "mark_done", durationMs: 45.2, ok: true },
      { kind: "tool", name: "add_note", durationMs: 10.9, ok: false },
    ]);
    const steps = getChatPerfStepsForRequest("stepstest-1");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ kind: "prep", name: "fetch_user_ops_tasks", durationMs: 124, ok: true });
    expect(steps[1]).toMatchObject({ kind: "tool", name: "mark_done", durationMs: 45, ok: true });
    expect(steps[2]).toMatchObject({ kind: "tool", name: "add_note", durationMs: 11, ok: false });
    // בכוונה: אין עמודת ארגומנטים/תוכן/תוצאה כלשהי בשורה
    const raw = db.prepare(`SELECT * FROM chat_perf_steps WHERE request_id = 'stepstest-1' LIMIT 1`).get() as Record<string, unknown>;
    expect("input" in raw || "args" in raw || "result" in raw || "content" in raw).toBe(false);
  });

  it("רשימה ריקה: לא כותבת כלום (אין שורות סתם)", () => {
    recordChatPerfSteps("stepstest-empty", []);
    expect(getChatPerfStepsForRequest("stepstest-empty")).toHaveLength(0);
  });

  it("שני request_id שונים לא מתערבבים", () => {
    recordChatPerfSteps("stepstest-a", [{ kind: "tool", name: "x", durationMs: 1, ok: true }]);
    recordChatPerfSteps("stepstest-b", [{ kind: "tool", name: "y", durationMs: 2, ok: true }]);
    expect(getChatPerfStepsForRequest("stepstest-a").map((s) => s.name)).toEqual(["x"]);
    expect(getChatPerfStepsForRequest("stepstest-b").map((s) => s.name)).toEqual(["y"]);
  });

  it("ניקוי: מוחק רק שורות ישנות מ-N ימים", () => {
    db.prepare(
      `INSERT INTO chat_perf_steps (request_id, kind, name, duration_ms, ok, created_at)
       VALUES ('stepstest-old', 'tool', 'x', 5, 1, datetime('now', '-40 days'))`,
    ).run();
    recordChatPerfSteps("stepstest-new", [{ kind: "tool", name: "x", durationMs: 5, ok: true }]);

    const pruned = pruneChatPerfSteps(30);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(getChatPerfStepsForRequest("stepstest-old")).toHaveLength(0);
    expect(getChatPerfStepsForRequest("stepstest-new")).toHaveLength(1);
  });

  it("recordChatPerfStepsSafe לא זורקת כש-הטבלה חסרה (DROP+restore, לא משפיע על שאר הבדיקות)", () => {
    const createTableSql = fs
      .readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf-8")
      .match(/CREATE TABLE IF NOT EXISTS chat_perf_steps[\s\S]*?\);/)![0];
    let threw = false;
    try {
      db.exec(`DROP TABLE chat_perf_steps`);
      try {
        recordChatPerfStepsSafe("stepstest-gone", [{ kind: "tool", name: "x", durationMs: 1, ok: true }]);
      } catch {
        threw = true;
      }
    } finally {
      db.exec(createTableSql);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_perf_steps_request ON chat_perf_steps (request_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_perf_steps_created ON chat_perf_steps (created_at)`);
    }
    expect(threw).toBe(false);
  });

  it("getChatPerfStepsForRequestSafe מחזירה [] (לא זורקת) כש-הטבלה חסרה", () => {
    const createTableSql = fs
      .readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf-8")
      .match(/CREATE TABLE IF NOT EXISTS chat_perf_steps[\s\S]*?\);/)![0];
    let threw = false;
    let result: ReturnType<typeof getChatPerfStepsForRequestSafe> | null = null;
    try {
      db.exec(`DROP TABLE chat_perf_steps`);
      try {
        result = getChatPerfStepsForRequestSafe("stepstest-gone2");
      } catch {
        threw = true;
      }
    } finally {
      db.exec(createTableSql);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_perf_steps_request ON chat_perf_steps (request_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_perf_steps_created ON chat_perf_steps (created_at)`);
    }
    expect(threw).toBe(false);
    expect(result).toEqual([]);
  });
});
