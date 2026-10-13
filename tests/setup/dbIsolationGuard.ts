/**
 * שומר הבידוד של ה-DB בבדיקות — פונקציה טהורה, נבדקת בעצמה ב-tests/unit/dbIsolation.test.ts.
 *
 * נתיב DB לבדיקות תקין רק אם:
 *   • הוא בתוך תיקיית ה-temp של מערכת ההפעלה, וגם
 *   • הוא מחוץ לריפו לגמרי (כולל data/agent.db וכל דבר אחר תחת data/).
 * כל דבר אחר → זורק. לא מסתפקים ב"שם קובץ שונה" או ב"שורות עם מזהה ייחודי" בתוך ה-DB האמיתי.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PRODUCTION_DB_PATH = path.join(REPO_ROOT, "data", "agent.db");

// realpath על התיקייה הקיימת הקרובה — ב-Windows ה-temp יכול להופיע בשם קצר (RUNNER~1) ובמק דרך symlink.
function canonical(p: string): string {
  let dir = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(dir)) {
    rest.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const real = path.join(fs.realpathSync.native(dir), ...rest);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function assertIsolatedDbPath(dbPath: string | undefined): string {
  if (!dbPath) throw new Error("בידוד DB: לא הוגדר נתיב DB לבדיקות");
  const target = canonical(dbPath);
  if (target === canonical(PRODUCTION_DB_PATH)) {
    throw new Error("בידוד DB: הנתיב מצביע על data/agent.db — אסור בבדיקות");
  }
  if (isInside(target, canonical(REPO_ROOT))) {
    throw new Error("בידוד DB: נתיב DB בתוך הריפו — חייב להיות בתיקיית temp חיצונית");
  }
  if (!isInside(target, canonical(os.tmpdir()))) {
    throw new Error("בידוד DB: נתיב DB מחוץ לתיקיית ה-temp של המערכת");
  }
  return target;
}

/**
 * נתיב ה-DB הזמני של קובץ הבדיקה הנוכחי — אחרי אימות בידוד. לבדיקות שפותחות חיבור SQLite נוסף
 * ("חיבור טרי" להוכחת persistence) במקום נתיב קשיח כמו "data/agent.db".
 */
export function isolatedDbPath(): string {
  const p = process.env.AGENT_DB_PATH;
  assertIsolatedDbPath(p);
  return p!;
}
