/**
 * "אובדן הקשר בטיפול בשיחה" (audit 2026-10-19) — buildAboutBlockLines (src/ai/prompt.ts) מפוצל
 * ל-3 ענפים ברורים לפי about: (1) יש פריט Monday (hasMondayItem) — בדיוק הטקסט שהיה תמיד, ר'
 * tests/unit/sharedPrompt.test.ts להשוואה byte-for-byte למקור, לא כפול כאן. (2) אין itemId אבל
 * יש מזהה התחייבות (parseCommitmentId) — הקשר ממוקד ל-close_commitment עם ה-id המדויק, בלי
 * reply_*. (3) לא זה ולא זה — הקשר כללי בלבד, בלי להמציא שום מזהה.
 */

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/ai/prompt.js";
import { resolveUserByKey } from "../../src/identity/index.js";

const dov = resolveUserByKey("dov")!;

describe("buildAboutBlockLines — ענף התחייבות (itemId=null, findingKey=commitment:<id>)", () => {
  const prompt = buildSystemPrompt({
    channel: "web",
    user: dov,
    about: { itemId: null, source: null, findingKey: "commitment:42", taskName: "לשלוח הצעת מחיר ללקוח X" },
  });

  it("מכיל את ה-id המדויק פעמיים (done/cancelled) — לא מומצא, נגזר מ-findingKey", () => {
    const matches = prompt.match(/id=42/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
  it("מכוון ל-close_commitment", () => expect(prompt).toContain("close_commitment"));
  it("לא מכוון לשום כלי reply_* (אין itemId — אין פריט Monday לכתוב אליו)", () => {
    expect(prompt).not.toContain("reply_done");
    expect(prompt).not.toContain("reply_progress");
    expect(prompt).not.toContain("reply_defer");
  });
  it("מזכיר מפורשות שזו לא משימת Monday", () => expect(prompt).toContain("לא משימת Monday"));
  it("כולל את תיאור ההתחייבות (taskName)", () => expect(prompt).toContain("לשלוח הצעת מחיר ללקוח X"));
});

describe("buildAboutBlockLines — ענף הגנתי (itemId=null, findingKey לא בפורמט commitment:<id>)", () => {
  const prompt = buildSystemPrompt({
    channel: "web",
    user: dov,
    about: { itemId: null, source: null, findingKey: "some_other_kind:7", taskName: "נושא כלשהו" },
  });

  it("לא מכיל שום id= מומצא", () => expect(prompt).not.toMatch(/id=\d/));
  it("לא מכוון לשום כלי reply_*", () => {
    expect(prompt).not.toContain("reply_done");
    expect(prompt).not.toContain("reply_progress");
  });
  it("לא מכוון ל-close_commitment (אין בסיס לכך — לא ממציאים)", () => {
    // close_commitment מופיע תמיד בהוראות הכלליות ("איך לעבוד") — בודקים שהוא *לא* מופיע בהקשר
    // המוזרק של ה-about הזה (ליד ה-🔔), לא שהוא נעדר מהפרומפט כולו.
    const aboutSection = prompt.slice(prompt.indexOf("🔔"), prompt.indexOf("🔔") + 400);
    expect(aboutSection).not.toContain("close_commitment");
  });
  it("עדיין מזריק הקשר קצר שהעובד יודע למה מתייחסים", () => {
    expect(prompt).toContain("נושא כלשהו");
  });
});

describe("buildAboutBlockLines — בלי about בכלל", () => {
  it("אין בלוק 🔔 כשאין about", () => {
    const prompt = buildSystemPrompt({ channel: "web", user: dov });
    expect(prompt).not.toContain("🔔");
  });
});
