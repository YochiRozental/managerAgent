/**
 * רץ לפני כל קובץ בדיקה (setupFiles), לפני שהקוד הנבדק נטען. שלוש שכבות:
 *   1. רשת — חסימה ברמת socket + fetch (networkGuard.ts).
 *   2. סודות — .env לא נטען, סודות מהטרמינל נדרסים בערך דמה (envIsolation.ts).
 *   3. DB — AGENT_DB_PATH מופנה ל-DB זמני חדש מחוץ לריפו, ומאומת (dbIsolationGuard.ts).
 * אם אחת מהן לא ניתנת להבטחה — הקובץ נכשל מיד.
 *
 * בנוסף: קובץ בדיקה רגיל שניסה לגשת לרשת נכשל בסוף — גם אם הקוד הנבדק "בלע" את השגיאה.
 * רק קובץ שמצהיר במפורש (allowNetworkProbes) — בדיקת החסימה עצמה — פטור.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, inject } from "vitest";
import { assertIsolatedDbPath } from "./dbIsolationGuard.js";
import { isolateEnv } from "./envIsolation.js";
import * as guard from "./networkGuard.js";

const root = inject("testTmpRoot");
if (!root) throw new Error("בידוד: globalSetup לא סיפק תיקיית temp — עוצרים");

// הפטור הוא לקובץ אחד בלבד — לא דולף לקובץ הבא אם התהליך ממוחזר
delete (globalThis as { allowNetworkProbes?: boolean }).allowNetworkProbes;
guard.installNetworkGuard();
afterAll(() => {
  if (guard.blockedAttempts > 0 && !(globalThis as { allowNetworkProbes?: boolean }).allowNetworkProbes) {
    throw new Error(`בידוד: הקוד הנבדק ניסה לגשת לרשת ${guard.blockedAttempts} פעמים`);
  }
});

const fileTmp = fs.mkdtempSync(path.join(root, "file-"));
isolateEnv(fileTmp);

const dbPath = path.join(fileTmp, "agent.test.db");
assertIsolatedDbPath(dbPath);
process.env.AGENT_DB_PATH = dbPath;
