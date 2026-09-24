/**
 * בדיקת lifecycle ל-socket של WhatsApp — בלי חיבור אמיתי, בלי auth/whatsapp, בלי QR.
 * מדמה boot → open → disconnect → reconnect (socket חדש) ומוודא שכל שולח מושך תמיד את
 * ה-socket הנוכחי (connectionState.ts) ולא מחזיק reference ישן. גם בודקת שה-outboxDrainer
 * לא שולח את אותה הודעה פעמיים כששני tick-ים חופפים.
 *
 * כותבת שורת בדיקה זמנית ל-whatsapp_outbox המקומי (data/agent.db) ומוחקת אותה בסיום —
 * לא נוגעת ב-auth/whatsapp ולא מתחברת בפועל ל-WhatsApp.
 *
 *   npm run test:whatsapp-lifecycle
 */
import type { WASocket } from "@whiskeysockets/baileys";
import { getConnectionState, getSocket, isReady, setSocket, setState } from "../src/integrations/whatsapp/connectionState.js";
import { sendText, setTyping, WhatsAppNotReadyError } from "../src/integrations/whatsapp/send.js";
import { drainOnce } from "../src/integrations/whatsapp/outboxDrainer.js";
import { enqueueWhatsapp, listUnsentWhatsapp } from "../src/db/repositories/whatsappOutbox.js";
import { db } from "../src/db/db.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

function fakeSocket(id: string) {
  const calls: { sendMessage: number } = { sendMessage: 0 };
  const sock = {
    authState: { creds: {} as { me?: { id: string } } },
    sendMessage: async (_jid: string, _content: unknown) => {
      calls.sendMessage++;
      return { key: { id: `msg-${id}-${calls.sendMessage}` } };
    },
    sendPresenceUpdate: async () => {},
  };
  return { sock: sock as unknown as WASocket, calls };
}

function fakeSlowSocket(id: string, delayMs: number) {
  const calls: { sendMessage: number } = { sendMessage: 0 };
  const sock = {
    authState: { creds: { me: { id } } },
    sendMessage: async (_jid: string, _content: unknown) => {
      calls.sendMessage++;
      await new Promise((r) => setTimeout(r, delayMs));
      return { key: { id: `msg-${id}-${calls.sendMessage}` } };
    },
    sendPresenceUpdate: async () => {},
  };
  return { sock: sock as unknown as WASocket, calls };
}

async function expectNotReadyFast(label: string) {
  const start = Date.now();
  try {
    await sendText("972500000000@s.whatsapp.net", "בדיקה", { source: "manual_test" });
    check(label, false, "sendText לא זרק שגיאה בכלל");
  } catch (err) {
    const elapsed = Date.now() - start;
    check(label, err instanceof WhatsAppNotReadyError, `זרק סוג אחר: ${(err as Error)?.constructor?.name}`);
    check(`${label} — נכשל מהר, בלי retry סרק`, elapsed < 1000, `לקח ${elapsed}ms`);
  }
}

async function main() {
  // 1. מצב התחלתי — לא מחובר כלל
  check("מצב התחלתי: getSocket()===null", getSocket() === null);
  check("מצב התחלתי: getConnectionState()==='closed'", getConnectionState() === "closed");
  check("מצב התחלתי: isReady()===false", !isReady());
  await expectNotReadyFast("שליחה כשלא מחובר בכלל → WhatsAppNotReadyError מיידי");

  // 2. socket קיים אבל עדיין לא אומת (open בלי creds.me) — למשל אמצע reconnect
  const { sock: sockNoMe } = fakeSocket("no-me");
  setSocket(sockNoMe, "open");
  check("socket open בלי creds.me → isReady()===false", !isReady());
  await expectNotReadyFast("שליחה כש-socket open אך לא מאומת → WhatsAppNotReadyError");

  // 3. socket ראשון מאומת ומחובר — שליחה אמורה להצליח ולהגיע בדיוק אליו
  const { sock: sockA, calls: callsA } = fakeSocket("A");
  (sockA as unknown as { authState: { creds: { me: { id: string } } } }).authState.creds.me = { id: "111" };
  setSocket(sockA, "open");
  check("socket A מאומת + open → isReady()===true", isReady());
  await sendText("972500000000@s.whatsapp.net", "שלום", { source: "manual_test" });
  check("sendText הצליח מול socket A", callsA.sendMessage === 1, `נקרא ${callsA.sendMessage} פעמים`);

  // 4. ניתוק — לפני שהוחלט אם זה reconnect או logged-out, isReady חייב לרדת מיד
  setState("closed");
  check("אחרי ניתוק: isReady()===false", !isReady());
  await expectNotReadyFast("שליחה מיד אחרי ניתוק → WhatsAppNotReadyError מיידי");
  check("sendText לא ניסה לשלוח על socket A שכבר סגור", callsA.sendMessage === 1);

  // 5. reconnect — נוצר socket חדש לגמרי (B). שולח חייב לפנות אליו, לא ל-A הישן.
  const { sock: sockB, calls: callsB } = fakeSocket("B");
  (sockB as unknown as { authState: { creds: { me: { id: string } } } }).authState.creds.me = { id: "222" };
  setSocket(sockB, "connecting");
  check("אחרי reconnect (connecting): isReady()===false עד שיגיע open", !isReady());
  setState("open");
  check("אחרי open מחדש: isReady()===true", isReady());
  await sendText("972500000000@s.whatsapp.net", "אחרי reconnect", { source: "manual_test" });
  check("השליחה הגיעה ל-socket B החדש", callsB.sendMessage === 1, `נקרא ${callsB.sendMessage} פעמים`);
  check("socket A הישן לא קיבל אף שליחה נוספת (לא stale reference)", callsA.sendMessage === 1);

  // 6. setTyping הוא best-effort — לא זורק גם כשלא מחובר
  setState("closed");
  let typingThrew = false;
  try {
    await setTyping("972500000000@s.whatsapp.net", true);
  } catch {
    typingThrew = true;
  }
  check("setTyping לא זורק גם כש-WhatsApp לא מחובר (best-effort)", !typingThrew);

  // 7. outboxDrainer: שני tick-ים חופפים לא שולחים את אותה הודעה פעמיים
  //
  // drainOnce() האמיתי מרוקן את *כל* התור (עד 20 הודעות), לא רק הודעת בדיקה בודדת — אם יש כבר
  // הודעות אמיתיות ממתינות ב-whatsapp_outbox המקומי (למשל מהרצת מתזמן קודמת), הרצת drainOnce()
  // כאן הייתה "שולחת" אותן דרך ה-socket המזויף ומסמנת sent_at, בלי שהן יצאו בפועל — בדיוק
  // האיבוד השקט שאסור לגרום לו. לכן: אם יש כבר הודעות ממתינות שלא שייכות לבדיקה הזו, מדלגים
  // על הבדיקה הזו לגמרי במקום לגעת בהן.
  const preExisting = listUnsentWhatsapp();
  if (preExisting.length > 0) {
    logger.warn(
      { count: preExisting.length, ids: preExisting.map((m) => m.id) },
      "⚠️ יש כבר הודעות ממתינות ב-whatsapp_outbox המקומי — מדלג על בדיקת ה-drainer כדי לא לגעת בהן. בדוק/י ידנית.",
    );
  } else {
    const testJid = "972500000000@s.whatsapp.net";
    const testBody = `[בדיקת lifecycle] ${new Date().toISOString()}`;
    enqueueWhatsapp(testJid, testBody);
    const { sock: slowSock, calls: slowCalls } = fakeSlowSocket("slow", 300);
    setSocket(slowSock, "open");
    check("socket איטי מוכן לפני בדיקת ה-drainer", isReady());

    try {
      await Promise.all([drainOnce(), drainOnce()]);
      check(
        "שני drainOnce() חופפים → sendMessage נקרא פעם אחת בלבד (guard מנע כפילות)",
        slowCalls.sendMessage === 1,
        `נקרא ${slowCalls.sendMessage} פעמים`,
      );

      const stillUnsent = listUnsentWhatsapp().filter((m) => m.body === testBody);
      check("ההודעה סומנה כנשלחה (לא נשארה unsent)", stillUnsent.length === 0);
    } finally {
      // ניקוי — מוחקים רק את שורת הבדיקה שיצרנו, לא נוגעים בשום דבר אחר בתור
      db.prepare("DELETE FROM whatsapp_outbox WHERE body = ?").run(testBody);
    }
  }

  // איפוס למצב נקי לסיום
  setSocket(null, "closed");

  if (failed) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-lifecycle של WhatsApp עברו ✅ (בלי חיבור אמיתי, בלי לגעת ב-auth/whatsapp)");
  process.exit(0); // exit מפורש — סקריפט חד-פעמי, לא תלוי בריקון event loop טבעי

}

main().catch((err) => {
  logger.error(err, "test-whatsapp-lifecycle נכשל");
  process.exit(1);
});
