/**
 * מוכיח שמנגנון בידוד ה-DB עובד — לפני שבדיקה כלשהי תיגע ב-src/db:
 *   • setup הפנה את AGENT_DB_PATH ל-temp מחוץ לריפו, ו-src/db/db.ts באמת פתח אותו.
 *   • השומר דוחה data/agent.db, כל נתיב בתוך הריפו, וכל נתיב מחוץ ל-temp.
 *   • db.ts עצמו fail-closed תחת Vitest כש-AGENT_DB_PATH חסר.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { assertIsolatedDbPath, PRODUCTION_DB_PATH, REPO_ROOT } from "../setup/dbIsolationGuard.js";

describe("בידוד DB בבדיקות", () => {
  it("AGENT_DB_PATH מוגדר, בתוך temp ומחוץ לריפו", () => {
    expect(() => assertIsolatedDbPath(process.env.AGENT_DB_PATH)).not.toThrow();
  });

  it("src/db/db.ts פותח את ה-DB הזמני — לא את data/agent.db", async () => {
    const { db } = await import("../../src/db/db.js");
    const main = (db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find((r) => r.name === "main");
    expect(main).toBeDefined();
    expect(fs.realpathSync.native(main!.file)).toBe(fs.realpathSync.native(process.env.AGENT_DB_PATH!));
    // הסכמה הוחלה על ה-DB הזמני, וכתיבה אליו עובדת
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("notifications");
    db.exec("CREATE TABLE isolation_probe (x INTEGER)");
    db.exec("INSERT INTO isolation_probe VALUES (1)");
    expect(db.prepare("SELECT COUNT(*) AS n FROM isolation_probe").get()).toEqual({ n: 1 });
  });

  it("השומר דוחה את data/agent.db", () => {
    expect(() => assertIsolatedDbPath(PRODUCTION_DB_PATH)).toThrow(/data\/agent\.db/);
    expect(() => assertIsolatedDbPath("data/agent.db")).toThrow();
  });

  it("השומר דוחה כל נתיב בתוך הריפו", () => {
    expect(() => assertIsolatedDbPath(path.join(REPO_ROOT, "data", "other.db"))).toThrow();
    expect(() => assertIsolatedDbPath(path.join(REPO_ROOT, "tests", "x.db"))).toThrow();
  });

  it("השומר דוחה נתיב מחוץ ל-temp ונתיב ריק", () => {
    expect(() => assertIsolatedDbPath(path.join(path.parse(REPO_ROOT).root, "not-temp", "x.db"))).toThrow();
    expect(() => assertIsolatedDbPath(undefined)).toThrow();
    expect(() => assertIsolatedDbPath("")).toThrow();
  });
});

describe("db.ts fail-closed תחת Vitest", () => {
  const savedPath = process.env.AGENT_DB_PATH;
  const savedCwd = process.cwd();
  afterEach(() => {
    process.env.AGENT_DB_PATH = savedPath;
    process.chdir(savedCwd);
    vi.resetModules();
  });

  it("בלי AGENT_DB_PATH — db.ts זורק ולא יוצר שום קובץ DB", async () => {
    // גם אם השומר היה נשבר — cwd זמני, כך ש-"data/agent.db" היחסי לא יכול להגיע לריפו
    const sandbox = fs.mkdtempSync(path.join(inject("testTmpRoot"), "failclosed-"));
    process.chdir(sandbox);
    delete process.env.AGENT_DB_PATH;
    vi.resetModules();
    await expect(import("../../src/db/db.js")).rejects.toThrow(/AGENT_DB_PATH/);
    expect(fs.existsSync(path.join(sandbox, "data"))).toBe(false);
  });
});
