/**
 * אורקסטרציית idempotency כלל-צ'אט (audit שלב ה, 2026-10-11) — העטיפה ש-server/index.ts מריץ
 * מעל runOpsChat. מופרד מה-HTTP handler בכוונה כדי שיהיה ניתן לבדיקה ישירה (scripts/
 * test-chat-dedup.ts) בלי לספק HTTP אמיתי.
 *
 * clientMessageId הוא עכשיו המזהה ה-**ראשי** (לא turnOrdinal — ר' ops/attendanceEngine.ts's
 * MessageIdentity ו-ops/chat.ts). חסר clientMessageId (קורא ישן/לא-חלונית) → עובר ישר ל-run(),
 * בלי dedup כלל — תאימות לאחור מלאה, אפס שינוי התנהגות לכל מי שלא שולח אותו.
 */

import {
  claimChatMessage,
  finishChatMessage,
  releaseChatMessageClaim,
  getChatMessageClaim,
} from "../db/repositories/chatMessageDedup.js";

export class ChatMessageConflictError extends Error {
  readonly code = "client_message_id_conflict";
  constructor() {
    super("ההודעה הזו (מזהה) נשלחה בעבר עם תוכן אחר — לא עיבדתי את הבקשה הנוכחית, כדי לא לדרוס/לאבד תיקון בשקט.");
  }
}

export class ChatMessageStillProcessingError extends Error {
  readonly code = "still_processing";
  constructor() {
    super("ההודעה הזו עדיין בעיבוד (ניסיון קודם לא הסתיים) — נסה שוב בעוד רגע.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunDedupedChatTurnOptions {
  /** קטן בבדיקות כדי לא להאריך אותן; ברירת מחדל מתאימה לייצור (עד ~15 שנ' המתנה לניסיון מקביל). */
  waitTimeoutMs?: number;
  waitIntervalMs?: number;
}

export interface DedupedRunOutcome<T> {
  result: T;
  /** true ⇔ זה היה retry/מקביל שהוחזר מה-cache — run() לא רץ שוב. */
  cached: boolean;
}

/**
 * עוטפת run() בהגנת idempotency. run() נקרא **לכל היותר פעם אחת** לכל (userKey,clientMessageId)
 * שהצליח — גם אם הפונקציה הזו עצמה נקראת כמה פעמים (retry/שתי "לשוניות" ששולחות את אותה הודעה
 * בדיוק). שתי הודעות *שונות* (clientMessageId שונה) לעולם לא חוסמות זו את זו.
 */
export async function runDedupedChatTurn<T>(
  userKey: string,
  clientMessageId: string | undefined,
  sessionId: string,
  contentHash: string,
  run: () => Promise<T>,
  opts: RunDedupedChatTurnOptions = {},
): Promise<DedupedRunOutcome<T>> {
  if (!clientMessageId) return { result: await run(), cached: false }; // תאימות לאחור — אין dedup בלי מזהה

  const waitTimeoutMs = opts.waitTimeoutMs ?? 15_000;
  const waitIntervalMs = opts.waitIntervalMs ?? 250;

  const claim = claimChatMessage(userKey, clientMessageId, sessionId, contentHash);

  if (claim.kind === "conflict") throw new ChatMessageConflictError();
  if (claim.kind === "done") return { result: claim.result as T, cached: true };

  if (claim.kind === "processing") {
    // ניסיון קודם (אותה הודעה בדיוק) עדיין רץ — מחכים לו, לא מריצים run() שני במקביל.
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(waitIntervalMs);
      const row = getChatMessageClaim(userKey, clientMessageId);
      if (!row) break; // שוחרר (הניסיון הקודם נכשל) — יוצאים מהלולאה ומנסים לתפוס מחדש למטה
      if (row.contentHash !== contentHash) throw new ChatMessageConflictError();
      if (row.status === "done") return { result: row.result as T, cached: true };
    }
    // אחרי שהלולאה הסתיימה (שוחרר, או timeout) — ניסיון תפיסה נוסף; אם עדיין תפוס (timeout
    // אמיתי, לא released) זה *לא* יצליח, ונזרקת still_processing — לא "הצלחה" מומצאת.
    const reclaim = claimChatMessage(userKey, clientMessageId, sessionId, contentHash);
    if (reclaim.kind === "done") return { result: reclaim.result as T, cached: true };
    if (reclaim.kind === "conflict") throw new ChatMessageConflictError();
    if (reclaim.kind !== "claimed") throw new ChatMessageStillProcessingError();
  }

  try {
    const result = await run();
    finishChatMessage(userKey, clientMessageId, result);
    return { result, cached: false };
  } catch (err) {
    // כשל אמיתי — משחררים כדי שניסיון חוזר (אותו מזהה) יוכל לתפוס מחדש ולרוץ מההתחלה. **לעולם
    // לא** מסמנים 'done'/מחזירים הצלחה על בקשה שלא הצליחה בפועל.
    releaseChatMessageClaim(userKey, clientMessageId);
    throw err;
  }
}
