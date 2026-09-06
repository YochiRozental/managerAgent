import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = "data/agent.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

const schema = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");
db.exec(schema);

// מיגרציות קלות למסדי נתונים קיימים (ALTER ... IF NOT EXISTS לא נתמך ב-sqlite)
for (const stmt of ["ALTER TABLE chat_messages ADD COLUMN session_id TEXT"]) {
  try {
    db.exec(stmt);
  } catch {
    /* העמודה כבר קיימת */
  }
}
