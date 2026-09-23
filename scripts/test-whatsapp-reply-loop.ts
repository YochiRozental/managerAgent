/**
 * בדיקת ה-fix ל-infinite reply loop: הבוט לא צריך לענות לעצמו. בלי חיבור אמיתי, בלי auth/whatsapp.
 *
 * שורש התקלה שנמצאה: WhatsApp מהדהד בחזרה כל הודעה שהבוט שולח (type:"notify", fromMe:true,
 * אותו message id — פרוטוקול multi-device sync). markAsSentByBot() נקרא *אחרי* ה-await על
 * sock.sendMessage — אם ה-echo מהשרת הגיע לפני שהרשמנו את ה-id, הבוט "שמע" את התשובה של עצמו
 * כקלט חדש, ענה לה, וזה חזר על עצמו. התיקון: send.ts מבקש מ-Baileys messageId משלנו ורושם אותו
 * *לפני* השליחה (options.messageId) — סוגר את המירוץ מהשורש. מגן תוכן (jid+text) ומגן fail-safe
 * (rate-limit) הם שכבות הגנה נוספות, בלתי-תלויות ב-timing.
 *
 *   npm run test:whatsapp-reply-loop
 */
import type { WASocket } from "@whiskeysockets/baileys";
import { handleMessagesUpsert } from "../src/integrations/whatsapp/client.js";
import { setSocket } from "../src/integrations/whatsapp/connectionState.js";
import { sendText } from "../src/integrations/whatsapp/send.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

// jid נפרד לכל תרחיש: ה-fail-safe (סעיף 6) הוא per-jid ובכוונה מצטבר על פני קריאות — אם כל
// התרחישים היו חולקים jid אחד, המונה המשותף היה מפעיל אותו מוקדם מדי ומזייף כשלים בתרחישים
// שלא קשורים ל-fail-safe בכלל.
const JID_REPLY = "972500000001@s.whatsapp.net";
const JID_ECHO_EXACT = "972500000002@s.whatsapp.net";
const JID_SELF = "972500000003@s.whatsapp.net";
const JID_TWO_HUMANS = "972500000004@s.whatsapp.net";
const JID_DUP = "972500000005@s.whatsapp.net";
const JID_RESYNC = "972500000006@s.whatsapp.net";
const JID_BURST = "972500000007@s.whatsapp.net";

function fakeReadySocket() {
  const sentIds: string[] = [];
  const sock = {
    authState: { creds: { me: { id: "972533144083:1@s.whatsapp.net" } } },
    sendMessage: async (_jid: string, _content: unknown, options?: { messageId?: string }) => {
      const id = options?.messageId ?? `fallback-${sentIds.length}`;
      sentIds.push(id);
      return { key: { id } };
    },
    sendPresenceUpdate: async () => {},
  };
  return { sock: sock as unknown as WASocket, sentIds };
}

// בונה אובייקט בצורת WAMessage — רק השדות ש-handleMessagesUpsert בפועל נוגע בהם.
function fakeMessage(opts: { id: string; fromMe: boolean; text: string; jid: string }) {
  return {
    key: { id: opts.id, fromMe: opts.fromMe, remoteJid: opts.jid },
    message: { conversation: opts.text },
  } as Parameters<typeof handleMessagesUpsert>[0]["messages"][number];
}

function mockHandler() {
  const calls: { jid: string; text: string }[] = [];
  const handler = (jid: string, text: string) => calls.push({ jid, text });
  return { handler, calls };
}

async function main() {
  const { sock } = fakeReadySocket();
  setSocket(sock, "open");

  // --- 1. human incoming → bot reply → echo/upsert של תשובת הבוט → אין reply נוסף ---
  {
    const { handler, calls } = mockHandler();
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "HUM-1", fromMe: false, text: "בוקר טוב", jid: JID_REPLY })], type: "notify" },
      sock,
      handler,
    );
    check("הודעה אנושית נכנסת → onMessage נקרא פעם אחת", calls.length === 1, `נקרא ${calls.length} פעמים`);

    // הבוט "עונה" (כמו ש-messageHandler.ts היה עושה) — sendText כבר רושם jid+text לפני השליחה.
    const botReplyText = "בוקר טוב! מה אני יכול לעזור?";
    await sendText(JID_REPLY, botReplyText);

    // מדמים את ה-echo מהשרת עם id *אחר* (למשל אם Baileys/WA אי-פעם יעטפו מחדש את ה-id) —
    // בודק שכבת ההגנה השנייה, לפי תוכן, ולא רק לפי id.
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "SERVER-ECHO-DIFFERENT-ID", fromMe: true, text: botReplyText, jid: JID_REPLY })], type: "notify" },
      sock,
      handler,
    );
    check(
      "echo של תשובת הבוט עם id שונה אך תוכן זהה → מזוהה לפי תוכן, לא מפעיל onMessage",
      calls.length === 1,
      `onMessage נקרא ${calls.length} פעמים`,
    );
  }

  // --- וריאציה מדויקת יותר: ה-echo מגיע עם אותו id בדיוק ש-Baileys היה מחזיר ---
  {
    const { handler, calls } = mockHandler();
    const replyText = "התשובה השנייה של הבוט";
    let capturedId = "";
    const capturingSock = {
      ...(sock as unknown as Record<string, unknown>),
      sendMessage: async (_jid: string, _content: unknown, options?: { messageId?: string }) => {
        capturedId = options?.messageId ?? "";
        return { key: { id: capturedId } };
      },
    } as unknown as WASocket;
    setSocket(capturingSock, "open");

    await sendText(JID_ECHO_EXACT, replyText);
    check("sendText קיבל messageId ורשם אותו לפני השליחה", capturedId.length > 0);

    handleMessagesUpsert(
      { messages: [fakeMessage({ id: capturedId, fromMe: true, text: replyText, jid: JID_ECHO_EXACT })], type: "notify" },
      capturingSock,
      handler,
    );
    check("echo עם אותו id בדיוק → לא מפעיל onMessage (המנגנון המקורי שהיה שבור)", calls.length === 0, `onMessage נקרא ${calls.length} פעמים`);

    setSocket(sock, "open"); // מחזירים את ה-socket הרגיל להמשך הבדיקות
  }

  // --- 2. self-chat command שהאדם הקליד ממכשיר מקושר אחר (fromMe:true, לא נשלח על ידינו) → כן מעובד ---
  {
    const { handler, calls } = mockHandler();
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "SELF-1", fromMe: true, text: "סיימתי את המשימה", jid: JID_SELF })], type: "notify" },
      sock,
      handler,
    );
    check("פקודת self-chat אמיתית (fromMe:true, לא echo) → onMessage נקרא", calls.length === 1 && calls[0]?.text === "סיימתי את המשימה");
  }

  // --- 3. שתי הודעות אנושיות רצופות → כל אחת מעובדת פעם אחת ---
  {
    const { handler, calls } = mockHandler();
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "HUM-2", fromMe: false, text: "הודעה א", jid: JID_TWO_HUMANS })], type: "notify" },
      sock,
      handler,
    );
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "HUM-3", fromMe: false, text: "הודעה ב", jid: JID_TWO_HUMANS })], type: "notify" },
      sock,
      handler,
    );
    check(
      "שתי הודעות אנושיות נפרדות → onMessage נקרא פעמיים, בסדר הנכון",
      calls.length === 2 && calls[0]?.text === "הודעה א" && calls[1]?.text === "הודעה ב",
      JSON.stringify(calls),
    );
  }

  // --- 4. duplicate upsert של אותה הודעה בדיוק → מעובד פעם אחת בלבד ---
  {
    const { handler, calls } = mockHandler();
    const dup = fakeMessage({ id: "HUM-DUP", fromMe: false, text: "הודעה כפולה", jid: JID_DUP });
    handleMessagesUpsert({ messages: [dup], type: "notify" }, sock, handler);
    handleMessagesUpsert({ messages: [dup], type: "notify" }, sock, handler); // אותו id בדיוק, upsert שני
    check("שני upsert-ים לאותה הודעה (אותו id) → onMessage נקרא פעם אחת בלבד", calls.length === 1, `נקרא ${calls.length} פעמים`);
  }

  // --- 5. reconnect/offline sync → הודעות שכבר עובדו לא מפעילות orchestrator שוב ---
  {
    const { handler, calls } = mockHandler();
    const msg = fakeMessage({ id: "HUM-RESYNC", fromMe: false, text: "הודעה לפני ניתוק", jid: JID_RESYNC });
    handleMessagesUpsert({ messages: [msg], type: "notify" }, sock, handler);
    check("הודעה טופלה פעם ראשונה", calls.length === 1);

    // reconnect: socket חדש (כמו client.ts היה עושה), אבל ה-id כבר מוכר מהתהליך — לא אמור לרוץ שוב
    const { sock: newSock } = fakeReadySocket();
    handleMessagesUpsert({ messages: [msg], type: "notify" }, newSock, handler);
    check("resync אחרי reconnect עם אותו id → לא מפעיל onMessage שוב", calls.length === 1, `נקרא ${calls.length} פעמים`);

    // גיבוי היסטוריה אופליין (type:"append") — לא אמור להגיע ל-onMessage בכלל, גם עם id חדש
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "HIST-1", fromMe: false, text: "הודעה מהיסטוריה", jid: JID_RESYNC })], type: "append" },
      newSock,
      handler,
    );
    check("סנכרון היסטוריה אופליין (type:'append') → לא מפעיל onMessage בכלל", calls.length === 1, `נקרא ${calls.length} פעמים`);
  }

  // --- 6. רשת ביטחון: יותר מדי הודעות "חדשות" מאותו jid בזמן קצר → מפסיק להגיב (fail-safe) ---
  {
    const { handler, calls } = mockHandler();
    for (let i = 0; i < 8; i++) {
      handleMessagesUpsert(
        { messages: [fakeMessage({ id: `BURST-${i}`, fromMe: false, text: `הודעה ${i}`, jid: JID_BURST })], type: "notify" },
        sock,
        handler,
      );
    }
    check(
      "8 הודעות שונות תוך שניות מאותו jid → ה-fail-safe עוצר לפני שכולן עוברות",
      calls.length > 0 && calls.length < 8,
      `onMessage נקרא ${calls.length} מתוך 8`,
    );

    // אחרי שה-breaker נדלק, גם הודעה "לגיטימית" נוספת נדחית עד סוף הצינון (לא רק ה-burst עצמו)
    const before = calls.length;
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "AFTER-BREAKER", fromMe: false, text: "עוד הודעה", jid: JID_BURST })], type: "notify" },
      sock,
      handler,
    );
    check("אחרי שה-fail-safe נדלק, הודעה חדשה נוספת גם נדחית (בצינון)", calls.length === before, `נקרא ${calls.length}, היה ${before}`);
  }

  if (failed) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-reply-loop עברו ✅ (בלי חיבור אמיתי, בלי לגעת ב-auth/whatsapp)");
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, "test-whatsapp-reply-loop נכשל");
  process.exit(1);
});
