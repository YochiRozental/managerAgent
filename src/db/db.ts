import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = "data/agent.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// WAL — קורא וכותב לא חוסמים זה את זה (הסורק הכבד רץ בזמן שעובד עדכן משימה מהחלונית),
// והקובץ פחות חשוף להשחתה בקריסה. busy_timeout — במקום להיכשל מיד על נעילה, לחכות עד 5ש'.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA synchronous = NORMAL");

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
