/**
 * ui.html הוא סקריפט יחיד עם הצהרות גלובליות. function declaration כפולה באותו שם לא נכשלת בתחביר (לכן
 * uiHtmlScriptSyntax לא תופס אותה) — ההצהרה המאוחרת פשוט דורסת את המוקדמת. כך, בשלב 3 של "הודעות צוות",
 * dayLabel חדש דרס את dayLabel הקיים של היסטוריית השיחות, וסרגל הצד הציג "אין שיחות שמורות". הבדיקה הזו
 * מוודאת שאף שם ברמה העליונה לא מוצהר פעמיים, ושאין id כפול ב-HTML.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(import.meta.dirname, "../../src/server/ui.html"), "utf-8");
const script = html.slice(html.lastIndexOf("<script>"));

describe("src/server/ui.html — אין הצהרות כפולות", () => {
  it("אין function/const/let/var ברמה העליונה שמוצהרים יותר מפעם אחת", () => {
    const re = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm;
    const counts = new Map<string, number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(script))) {
      const name = (m[1] ?? m[2])!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const dups = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
    expect(dups).toEqual([]);
  });

  it("אין id כפול ב-HTML", () => {
    const body = html.slice(0, html.lastIndexOf("<script>"));
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]!);
    const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dups).toEqual([]);
  });
});
