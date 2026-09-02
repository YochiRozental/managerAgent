import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = "data/agent.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

const schema = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");
db.exec(schema);
