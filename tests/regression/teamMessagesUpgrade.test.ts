/**
 * רגרסיה: שדרוג team_messages שנוצרה בשלב 1 (בלי `rev`) לגרסה עם cursor הסנכרון. DB זמני נפרד מחוץ
 * לריפו (לא ה-DB של הבדיקות ולא data/agent.db). מוכיח: הנתונים נשמרים, rev ממולא לפי סדר id בכל שיחה,
 * אינדקס ייחודי וטריגרים נוצרים רק אחרי שהעמודה קיימת, והשדרוג idempotent (הרצה חוזרת לא משנה כלום).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upgradeTeamMessagesSchema } from "../../src/db/db.js";

// הסכמה כפי שהייתה בשלב 1 — בלי rev, בלי UNIQUE על rev ובלי טריגרים.
const STAGE1_DDL = `
CREATE TABLE team_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm','group')),
  dm_key TEXT UNIQUE,
  title TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind <> 'dm' OR dm_key IS NOT NULL)
);
CREATE TABLE team_thread_members (
  thread_id INTEGER NOT NULL REFERENCES team_threads(id),
  user_key TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_key)
);
CREATE TABLE team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES team_threads(id),
  sender_key TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_id INTEGER,
  client_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT,
  deleted_at TEXT,
  UNIQUE (thread_id, sender_key, client_message_id),
  UNIQUE (thread_id, id),
  FOREIGN KEY (thread_id, reply_to_id) REFERENCES team_messages (thread_id, id)
);
CREATE INDEX idx_team_messages_thread ON team_messages (thread_id, id);
`;

let dir: string;
let conn: DatabaseSync;

const all = (sql: string) => conn.prepare(sql).all() as Record<string, unknown>[];
const one = (sql: string) => all(sql)[0]!;

function seedOldData(): void {
  conn.exec(`INSERT INTO team_threads (kind, dm_key, created_by) VALUES ('dm', 'dov|eitan', 'dov'), ('dm', 'dov|ruchama', 'dov')`);
  conn.exec(`INSERT INTO team_thread_members (thread_id, user_key, last_read_message_id) VALUES (1,'dov',0),(1,'eitan',2),(2,'dov',0),(2,'ruchama',0)`);
  // שיחה 1: 3 הודעות (אחת נערכה, אחת מחוקה, אחת תגובה); שיחה 2: הודעה אחת. ה-id הגלובלי משתרע על שתיהן.
  conn.exec(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id, edited_at) VALUES (1,'dov','הודעה ראשונה (ערוכה)','a1', '2026-10-01 10:00:00')`);
  conn.exec(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id) VALUES (2,'dov','שיחה אחרת','b1')`);
  conn.exec(`INSERT INTO team_messages (thread_id, sender_key, body, reply_to_id, client_message_id) VALUES (1,'eitan','תגובה',1,'a2')`);
  conn.exec(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id, deleted_at) VALUES (1,'dov','נמחקה','a3', '2026-10-02 09:00:00')`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-upgrade-"));
  conn = new DatabaseSync(path.join(dir, "old.db"));
  conn.exec(STAGE1_DDL);
});

afterEach(() => {
  try {
    conn.close();
  } catch {
    /* כבר סגור */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("שדרוג team_messages מסכמת שלב 1", () => {
  it("מוסיף rev, ממלא לפי id בכל שיחה, ושומר את כל הנתונים", () => {
    seedOldData();
    const before = all(`SELECT id, thread_id, sender_key, body, reply_to_id, client_message_id, created_at, edited_at, deleted_at FROM team_messages ORDER BY id`);
    const membersBefore = all(`SELECT * FROM team_thread_members ORDER BY thread_id, user_key`);
    expect(all(`PRAGMA table_info(team_messages)`).some((c) => c.name === "rev")).toBe(false);

    upgradeTeamMessagesSchema(conn);

    expect(all(`PRAGMA table_info(team_messages)`).some((c) => c.name === "rev")).toBe(true);
    const after = all(`SELECT id, thread_id, sender_key, body, reply_to_id, client_message_id, created_at, edited_at, deleted_at FROM team_messages ORDER BY id`);
    expect(after).toEqual(before);
    expect(all(`SELECT * FROM team_thread_members ORDER BY thread_id, user_key`)).toEqual(membersBefore);
    // rev: שיחה 1 → ids 1,3,4 ← 1,2,3 ; שיחה 2 → id 2 ← 1
    expect(all(`SELECT id, rev FROM team_messages ORDER BY id`)).toEqual([
      { id: 1, rev: 1 },
      { id: 2, rev: 1 },
      { id: 3, rev: 2 },
      { id: 4, rev: 3 },
    ]);
    expect(all(`PRAGMA foreign_key_check`)).toEqual([]);
    expect(one(`PRAGMA integrity_check`).integrity_check).toBe("ok");
  });

  it("אינדקס ייחודי וטריגרים קיימים אחרי השדרוג ופועלים (הוספה, עריכה, מחיקה)", () => {
    seedOldData();
    upgradeTeamMessagesSchema(conn);
    const idx = all(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_team_messages_thread_rev'`);
    const trg = all(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).map((r) => r.name);
    expect(idx).toHaveLength(1);
    expect(trg).toEqual(["trg_team_messages_rev_ins", "trg_team_messages_rev_upd"]);

    conn.exec(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id) VALUES (1,'eitan','חדשה','a4')`);
    expect(one(`SELECT rev FROM team_messages WHERE client_message_id='a4'`).rev).toBe(4);
    conn.exec(`UPDATE team_messages SET body = 'ערוכה' WHERE client_message_id='a1'`);
    expect(one(`SELECT rev FROM team_messages WHERE client_message_id='a1'`).rev).toBe(5);
    conn.exec(`UPDATE team_messages SET deleted_at = datetime('now') WHERE client_message_id='a2'`);
    expect(one(`SELECT rev FROM team_messages WHERE client_message_id='a2'`).rev).toBe(6);
    // השיחה האחרת לא הושפעה
    expect(one(`SELECT rev FROM team_messages WHERE client_message_id='b1'`).rev).toBe(1);
    // ייחודיות נאכפת
    expect(() => conn.exec(`UPDATE team_messages SET rev = 6 WHERE client_message_id='a3'`)).toThrow(/UNIQUE/i);
  });

  it("הרצה חוזרת לא משנה כלום (גם אחרי שנוספו שינויים) ולא זורקת", () => {
    seedOldData();
    upgradeTeamMessagesSchema(conn);
    conn.exec(`UPDATE team_messages SET body = 'שינוי' WHERE client_message_id='a1'`);
    const snapshot = all(`SELECT id, rev, body FROM team_messages ORDER BY id`);
    const schemaBefore = all(`SELECT type, name, sql FROM sqlite_master ORDER BY name`);
    expect(() => upgradeTeamMessagesSchema(conn)).not.toThrow();
    expect(() => upgradeTeamMessagesSchema(conn)).not.toThrow();
    expect(all(`SELECT id, rev, body FROM team_messages ORDER BY id`)).toEqual(snapshot);
    expect(all(`SELECT type, name, sql FROM sqlite_master ORDER BY name`)).toEqual(schemaBefore);
  });

  it("טבלה ריקה (בלי נתונים) משתדרגת", () => {
    upgradeTeamMessagesSchema(conn);
    upgradeTeamMessagesSchema(conn);
    expect(all(`PRAGMA table_info(team_messages)`).some((c) => c.name === "rev")).toBe(true);
    conn.exec(`INSERT INTO team_threads (kind, dm_key, created_by) VALUES ('dm','a|b','a')`);
    conn.exec(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id) VALUES (1,'a','x','c1')`);
    expect(one(`SELECT rev FROM team_messages`).rev).toBe(1);
  });

  it("אם נכשל באמצע — ROLLBACK מלא: אין עמודה, אין טריגרים, הנתונים שלמים", () => {
    seedOldData();
    // כשל אמיתי: העמודה קיימת וכל השורות בשיחה עם אותו rev → יצירת האינדקס הייחודי תיכשל באמצע השדרוג.
    conn.exec(`ALTER TABLE team_messages ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`);
    conn.exec(`UPDATE team_messages SET rev = 7`); // כל השורות באותה שיחה עם אותו rev → UNIQUE ייכשל
    expect(() => upgradeTeamMessagesSchema(conn)).toThrow();
    expect(all(`SELECT name FROM sqlite_master WHERE type='trigger'`)).toEqual([]);
    expect(all(`SELECT name FROM sqlite_master WHERE name='idx_team_messages_thread_rev'`)).toEqual([]);
    expect(all(`SELECT COUNT(*) AS c FROM team_messages`)[0]!.c).toBe(4);
    // והחיבור לא נשאר בטרנזקציה פתוחה
    expect(() => conn.exec(`BEGIN`)).not.toThrow();
    conn.exec(`ROLLBACK`);
  });
});
