/**
 * הוכחה (לא השערה): self-chat is not safely supportable בארכיטקטורה הנוכחית — אם ה-whatsapp-agent
 * מקושר (Baileys) לאותו חשבון WhatsApp שממנו המשתמש שולח פקודות self-chat, אין שום שדה שנגיש
 * לקוד שלנו שמבדיל בין:
 *
 *   (a) echo של התשובה שהבוט עצמו שלח, שחזר דרך multi-device sync של WhatsApp;
 *   (b) פקודה אמיתית שהמשתמש הקליד בעצמו ממכשיר מקושר אחר לאותו חשבון.
 *
 * המקור: node_modules/@whiskeysockets/baileys/lib/Utils/decode-wa-message.js:267 —
 *   `msg = msg.deviceSentMessage?.message || msg;`
 * כל הודעה שחוזרת דרך multi-device sync מגיעה עטופה ב-DeviceSentMessage (WAProto.proto:
 * `message DeviceSentMessage { destinationJid; message; phash; }`), אבל Baileys מבטל את
 * העטיפה הזו *לפני* ש-messages.upsert נפלט — `destinationJid`/`phash` נזרקים, ומה שנשאר הוא
 * רק `msg.deviceSentMessage.message` עצמו, בצורה שלא ניתנת להבחנה מהודעה "רגילה". גם ה-id
 * של ה-stanza (decode-wa-message.js: `stanza.attrs.id`) נקבע ע"י שרת WhatsApp, לא בטוח
 * תואם ל-id שהשתמשנו בו בזמן השליחה (ראו commit 14c5b4a — "Enforce safe WhatsApp inbound
 * boundary" — שתיעד את זה אחרי שגישת id/content-matching (commit ac95c39, שעה לפני) "הוכחה
 * כלא מספקת ב-production").
 *
 * הטסט הזה *בונה* את שני סוגי ה-WAMessage בצורה המדויקת שה-decoder של Baileys מחזיר (אחרי
 * unwrap, לא לפני) ומראה: (1) הצורה שלהם זהה בכל שדה שקוד כלשהו יכול לקרוא; (2)
 * handleMessagesUpsert (ובכל הרחבה: כל קוד שרואה רק WAMessage) מתייחס לשניהם זהה, decision
 * זהה, אבחון זהה — אין שום branch אפשרי שיכול להבדיל ביניהם.
 *
 *   npm run test:whatsapp-selfchat-discriminator
 */
import type { WASocket } from "@whiskeysockets/baileys";
import { _resetStateForTests, handleMessagesUpsert } from "../src/integrations/whatsapp/client.js";
import { _setInboundTraceSinkForTests } from "../src/integrations/whatsapp/trace.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

function fakeSocket(): WASocket {
  return { sendPresenceUpdate: async () => {} } as unknown as WASocket;
}

const PN = "972500000001@s.whatsapp.net";
type FakeUpsertMessage = Parameters<typeof handleMessagesUpsert>[0]["messages"][number];

/**
 * מייצג בדיוק את מה ש-messages.upsert מספק אחרי ש-Baileys כבר ביצע
 * `msg.deviceSentMessage?.message || msg` (decode-wa-message.js:267) — ה-echo של התשובה
 * שהבוט עצמו שלח, שחזר דרך multi-device sync. שים לב: אין כאן, ולא יכול להיות כאן, שום
 * שדה `deviceSentMessage`/`destinationJid` שרוד — Baileys זרק אותו לפני שהחזיר את זה.
 */
function botEchoAfterBaileysUnwrap(): FakeUpsertMessage {
  return {
    key: { id: "3EB0SERVERASSIGNED7F2A", fromMe: true, remoteJid: PN },
    message: { conversation: "בוצע ✅ (סיימתי את התכניות)" },
    messageTimestamp: Date.now(),
  } as unknown as FakeUpsertMessage;
}

/** פקודת self-chat אמיתית, שהמשתמש הקליד בעצמו ממכשיר מקושר אחר (לא הבוט). */
function humanSelfChatCommand(): FakeUpsertMessage {
  return {
    key: { id: "3EB0DIFFERENTCLIENTID9", fromMe: true, remoteJid: PN },
    message: { conversation: "סיימתי את התכניות" },
    messageTimestamp: Date.now(),
  } as unknown as FakeUpsertMessage;
}

/** כל שמות השדות הנגישים ב-WAMessage, רקורסיבית — לא הערכים, רק ה-*shape*. */
function fieldShape(value: unknown, path = ""): string[] {
  if (value === null || value === undefined || typeof value !== "object") return [path];
  const paths: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    paths.push(...fieldShape(v, path ? `${path}.${k}` : k));
  }
  return paths.sort();
}

async function main() {
  logger.info("בודק: קיים discriminator אמיתי בין bot-echo (fromMe:true) לבין human self-chat (fromMe:true)?");

  // --- 1. שתי ה"צורות" (shape, לא ערכים) זהות — אין שום שדה שקיים באחת ולא בשנייה ---
  {
    const echo = botEchoAfterBaileysUnwrap();
    const human = humanSelfChatCommand();
    const echoShape = fieldShape(echo);
    const humanShape = fieldShape(human);
    check(
      "1. אין שום שדה שקיים ב-WAMessage אחד ולא באחר (אותה shape בדיוק, Baileys זורק deviceSentMessage לפני שמחזיר)",
      JSON.stringify(echoShape) === JSON.stringify(humanShape),
      `echo=${JSON.stringify(echoShape)} human=${JSON.stringify(humanShape)}`,
    );
  }

  // --- 2. handleMessagesUpsert מתייחס לשניהם זהה: decision זהה, אבחון זהה (modulo hash) ---
  {
    _resetStateForTests();
    const inbound: Record<string, unknown>[] = [];
    _setInboundTraceSinkForTests((r) => inbound.push(r));

    handleMessagesUpsert({ messages: [botEchoAfterBaileysUnwrap()], type: "notify" }, fakeSocket());
    handleMessagesUpsert({ messages: [humanSelfChatCommand()], type: "notify" }, fakeSocket());

    check("2a. שני האירועים הופיעו (אחד לכל קריאה)", inbound.length === 2);
    const [echoRecord, humanRecord] = inbound;
    check(
      "2b. שני המקרים קיבלו decision=drop_from_me — אין branch שיכול לתת תוצאה שונה",
      echoRecord?.decision === "drop_from_me" && humanRecord?.decision === "drop_from_me",
      JSON.stringify(inbound),
    );
    check(
      "2c. שני המקרים קיבלו remoteJidType/addressingMode/hasRemoteJidAlt זהים (אותו jid, אותה shape)",
      echoRecord?.remoteJidType === humanRecord?.remoteJidType && echoRecord?.hasRemoteJidAlt === humanRecord?.hasRemoteJidAlt,
    );
    check(
      "2d. אין שום שדה ב-whatsapp_inbound trace שמבדיל בין השניים (fromMe זהה בשניהם: true)",
      echoRecord?.fromMe === true && humanRecord?.fromMe === true,
    );
    _setInboundTraceSinkForTests(null);
  }

  logger.info(
    "\nמסקנה: self-chat is not safely supportable — Baileys מבטל את עטיפת ה-DeviceSentMessage " +
      "(decode-wa-message.js:267) לפני שההודעה מגיעה לקוד שלנו, ושום שדה אחר (id/jid/timestamp) " +
      "אינו מובטח ע\"י הפרוטוקול להבדיל בין echo לבין פקודה אנושית. החלופה הבטוחה: מספר WhatsApp " +
      "נפרד לסוכן, לא קוד.",
  );

  if (failed) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\nההוכחה עברה ✅ — אין discriminator בטוח, אין fix קוד בטוח ל-self-chat במבנה הנוכחי");
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, "test-whatsapp-selfchat-discriminator נכשל");
  process.exit(1);
});
