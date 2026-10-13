/**
 * Idempotency כלל-צ'אט (audit שלב ה) — runDedupedChatTurn + chat_message_dedup. בודק: רטרי עם
 * אותו מזהה (לא רץ פעמיים), שני מזהים שונים (לא חוסמים זה את זה), conflict על תוכן שונה תחת אותו
 * מזהה, המתנה לניסיון מקביל "עדיין רץ" (לא מריץ run() כפול), והתאוששות מ-'processing' תקוע.
 *
 *   הועבר אחד-לאחד מ-scripts/test-chat-dedup.ts (הוסר). רץ ב-npm test, על DB זמני מבודד בלבד (tests/setup).
 */

import "dotenv/config";
import { db } from "../../src/db/db.js";
import { logger } from "../../src/utils/logger.js";
import {
  runDedupedChatTurn,
  ChatMessageConflictError,
  ChatMessageStillProcessingError,
} from "../../src/server/chatDedup.js";
import { recoverStuckChatMessageClaims, getChatMessageClaim } from "../../src/db/repositories/chatMessageDedup.js";
import { check } from "../helpers/check.js";


const USER = "test-dedup-user";
function cleanup(): void {
  db.prepare(`DELETE FROM chat_message_dedup WHERE user_key = ?`).run(USER);
}
cleanup();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // ── 1: אין clientMessageId → תאימות לאחור, run() רץ כרגיל, אין dedup ──────────────────────
  {
    let calls = 0;
    const r1 = await runDedupedChatTurn(USER, undefined, "s1", "hash1", async () => {
      calls++;
      return { reply: "תשובה", actions: [], session: "s1" };
    });
    const r2 = await runDedupedChatTurn(USER, undefined, "s1", "hash1", async () => {
      calls++;
      return { reply: "תשובה", actions: [], session: "s1" };
    });
    check("1. בלי clientMessageId: run() רץ בכל קריאה (אין dedup, תאימות לאחור)", calls === 2);
    check("1b. שתי התוצאות תקינות", r1.cached === false && r2.cached === false);
  }

  // ── 2: retry אמיתי — אותו clientMessageId, אותו תוכן, פעמיים → run() רץ פעם אחת בלבד ─────────
  {
    let calls = 0;
    const id = "cmid-retry-1";
    const run1 = await runDedupedChatTurn(USER, id, "s2", "hash-same", async () => {
      calls++;
      return { reply: "בוצע", actions: ["⏸️ נוכחות"], session: "s2" };
    });
    const run2 = await runDedupedChatTurn(USER, id, "s2", "hash-same", async () => {
      calls++; // לא אמור לרוץ
      return { reply: "בוצע-שוב", actions: [], session: "s2" };
    });
    check("2a. run() רץ רק פעם אחת", calls === 1, String(calls));
    check("2b. הניסיון הראשון לא היה cached", run1.cached === false);
    check("2c. הניסיון השני *כן* cached", run2.cached === true);
    check("2d. הניסיון השני מחזיר את תוצאת הניסיון הראשון בדיוק (לא רץ מחדש)", (run2.result as { reply: string }).reply === "בוצע");
  }

  // ── 3: שני מזהים שונים (שתי לשוניות) — לא חוסמים זה את זה, שניהם רצים ────────────────────────
  {
    let calls = 0;
    const rA = await runDedupedChatTurn(USER, "cmid-tabA", "s3", "hash-A", async () => {
      calls++;
      return { reply: "תשובה-א", actions: [], session: "s3" };
    });
    const rB = await runDedupedChatTurn(USER, "cmid-tabB", "s3", "hash-B", async () => {
      calls++;
      return { reply: "תשובה-ב", actions: [], session: "s3" };
    });
    check("3. שתי לשוניות עם מזהים שונים — run() רץ פעמיים (שתי הודעות אמיתיות)", calls === 2);
    check("3b. כל אחת קיבלה את התשובה שלה, לא מוזגו", (rA.result as { reply: string }).reply === "תשובה-א" && (rB.result as { reply: string }).reply === "תשובה-ב");
  }

  // ── 4: אותו מזהה, תוכן *אחר* → conflict, לא מעבד בשקט ────────────────────────────────────────
  {
    const id = "cmid-conflict-1";
    await runDedupedChatTurn(USER, id, "s4", "hash-original", async () => ({ reply: "ראשון", actions: [], session: "s4" }));
    let threw: unknown = null;
    try {
      await runDedupedChatTurn(USER, id, "s4", "hash-DIFFERENT", async () => ({ reply: "שני", actions: [], session: "s4" }));
    } catch (err) {
      threw = err;
    }
    check("4a. זורק ChatMessageConflictError", threw instanceof ChatMessageConflictError, String(threw));
    const claim = getChatMessageClaim(USER, id);
    check("4b. התוצאה השמורה נשארת 'ראשון' (לא נדרסה)", (claim?.result as { reply: string } | null)?.reply === "ראשון");
  }

  // ── 5: שני "תאים" עם *אותו* מזהה בדיוק, ממש במקביל — השני מחכה לראשון, לא רץ פעמיים ──────────
  {
    let calls = 0;
    const id = "cmid-concurrent-1";
    const slowRun = async () => {
      calls++;
      await sleep(300); // מדמה קריאת AI/DB איטית
      return { reply: "הושלם", actions: [], session: "s5" };
    };
    const [r1, r2] = await Promise.all([
      runDedupedChatTurn(USER, id, "s5", "hash-concurrent", slowRun),
      runDedupedChatTurn(USER, id, "s5", "hash-concurrent", slowRun, { waitTimeoutMs: 2000, waitIntervalMs: 20 }),
    ]);
    check("5a. run() רץ פעם אחת בלבד (לא שתיים, גם כש-'במקביל' ממש)", calls === 1, String(calls));
    check("5b. שתי הקריאות קיבלו את אותה תוצאה", (r1.result as { reply: string }).reply === "הושלם" && (r2.result as { reply: string }).reply === "הושלם");
  }

  // ── 6: כשל אמיתי בניסיון הראשון → claim משתחרר → retry (אותו מזהה) רץ מההתחלה ולא "תקוע" ──────
  {
    let attempt = 0;
    const id = "cmid-failure-retry-1";
    let threwFirst = false;
    try {
      await runDedupedChatTurn(USER, id, "s6", "hash-fail", async () => {
        attempt++;
        throw new Error("כשל מדומה בניסיון הראשון");
      });
    } catch {
      threwFirst = true;
    }
    check("6a. הניסיון הראשון (שנכשל) זרק שגיאה אמיתית (לא הצלחה מזויפת)", threwFirst);
    const retry = await runDedupedChatTurn(USER, id, "s6", "hash-fail", async () => {
      attempt++;
      return { reply: "הצליח בניסיון השני", actions: [], session: "s6" };
    });
    check("6b. ה-retry (אותו מזהה) רץ בפועל ולא נחסם לצמיתות", attempt === 2 && retry.cached === false);
    check("6c. ה-retry הצליח", (retry.result as { reply: string }).reply === "הצליח בניסיון השני");
  }

  // ── 7: 'processing' תקוע (קריסה בין claim לסיום) → recoverStuckChatMessageClaims משחזר ──────
  {
    const id = "cmid-stuck-1";
    db.prepare(`INSERT INTO chat_message_dedup (user_key, client_message_id, session_id, content_hash) VALUES (?, ?, ?, ?)`).run(
      USER,
      id,
      "s7",
      "hash-stuck",
    );
    check("7a. השורה קיימת ו-processing", getChatMessageClaim(USER, id)?.status === "processing");

    let stillProcessingThrown = false;
    try {
      await runDedupedChatTurn(USER, id, "s7", "hash-stuck", async () => ({ reply: "x", actions: [], session: "s7" }), {
        waitTimeoutMs: 100,
        waitIntervalMs: 20,
      });
    } catch (err) {
      stillProcessingThrown = err instanceof ChatMessageStillProcessingError;
    }
    check("7b. לפני שחזור: still_processing (לא 'תקוע לנצח' בשקט, גם לא הצלחה מזויפת)", stillProcessingThrown);

    const recovered = recoverStuckChatMessageClaims();
    check("7c. recoverStuckChatMessageClaims שחזר לפחות שורה אחת", recovered >= 1, String(recovered));
    check("7d. אחרי שחזור — השורה נמחקה (לא 'processing' תקוע)", getChatMessageClaim(USER, id) === null);

    const afterRecovery = await runDedupedChatTurn(USER, id, "s7", "hash-stuck", async () => ({ reply: "רץ אחרי שחזור", actions: [], session: "s7" }));
    check("7e. אחרי השחזור, ריצה עם אותו מזהה עובדת כרגיל", (afterRecovery.result as { reply: string }).reply === "רץ אחרי שחזור" && !afterRecovery.cached);
  }

  cleanup();
}

await run();
