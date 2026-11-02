import { ApiClient } from "@mondaydotcomorg/api";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";

export const mondayClient = new ApiClient({ token: env.MONDAY_API_TOKEN });

const RETRYABLE = /rate limit|complexity|timeout|ECONNRESET|ETIMEDOUT|429|503/i;
/**
 * שגיאות שבהן ברור ש-Monday לא עיבד את הבקשה (הגבלת קצב/מורכבות) — בטוח לנסות שוב גם בבקשת יצירה. timeout/ניתוק/503
 * *לא* כאלה: Monday ייתכן שיצר את הפריט לפני שהחיבור נפל, וניסיון חוזר יוצר כפילות.
 */
const SAFE_TO_RETRY_CREATE = /rate limit|complexity|429/i;
const CREATES_ITEM = /\bcreate_(item|subitem)\s*\(/;

/**
 * עטיפה ל-mondayClient.request עם ניסיונות חוזרים על שגיאות זמניות (rate limit / complexity budget /
 * ניתוקים). Monday מטיל תקרת מורכבות לכל דקה — קריאות כבדות רצופות (כמו משיכת לוח הבקרה של כמה
 * משתמשים) נחסמות זמנית, וזו שגיאה שכדאי פשוט לחכות ולנסות שוב.
 */
export async function mondayRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
  attempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await mondayClient.request<T>(query, variables);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (i === attempts - 1 || !RETRYABLE.test(msg)) throw err;
      if (CREATES_ITEM.test(query) && !SAFE_TO_RETRY_CREATE.test(msg)) throw err; // תוצאה לא ודאית — לא יוצרים כפילות
      const waitMs = 2000 * 2 ** i; // 2s, 4s, 8s
      logger.warn({ err: msg, waitMs, attempt: i + 1 }, "שגיאת Monday זמנית — ממתין ומנסה שוב");
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
