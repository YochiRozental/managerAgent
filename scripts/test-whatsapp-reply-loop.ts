/**
 * בדיקת ה-fix ל-infinite reply loop — סבב 4: OPTION SAFE.
 *
 * שינוי יסודי מהסבבים הקודמים: אחרי שהוכח (בקוד Baileys עצמו, decode-wa-message.js) שאין מזהה
 * (id) או ייצוג jid יציב שמבדיל בין ה-echo של הבוט על עצמו לבין פקודת self-chat אמיתית, ואחרי
 * שהוכח שגם "correlation אחד per טורן" לא עוצר שרשרת (כל echo שעובר בטעות מקבל correlation
 * *חדש* משלו) — הוסר כל ניסיון "לזהות" echo. במקומו: invariant בוליאני, לא הסתברותי:
 *
 *     msg.key.fromMe === true  →  DROP IMMEDIATELY, לפני dedup/breakers/correlation.
 *
 * `fromMe` הוא הסימן היחיד שבאמת אמין (מגיע מ-isMe(from)/isMeLid(from) ב-Baileys) — לא ה-id
 * ולא ה-jid. המחיר המכוון: אין יותר תמיכה בפקודות self-chat (fromMe:true ממכשיר מקושר אחר).
 * תעבורה אמיתית (עובדים/לקוחות) היא תמיד fromMe:false — לא מושפעת.
 *
 * חלק א׳: client.ts / handleMessagesUpsert.  חלק ב׳: replyCorrelation.ts (אכיפה, לא tracing).
 *
 *   npm run test:whatsapp-reply-loop
 */
import type { WASocket } from "@whiskeysockets/baileys";
import {
  _resetStateForTests,
  handleMessagesUpsert,
  isGloballyHalted,
  type MessageMeta,
} from "../src/integrations/whatsapp/client.js";
import { setSocket } from "../src/integrations/whatsapp/connectionState.js";
import { drainOnce } from "../src/integrations/whatsapp/outboxDrainer.js";
import { enqueueWhatsapp } from "../src/db/repositories/whatsappOutbox.js";
import { db } from "../src/db/db.js";
import {
  _resetCorrelationsForTests,
  consumeCorrelationForReply,
  createInboundCorrelation,
  InvalidCorrelationError,
} from "../src/integrations/whatsapp/replyCorrelation.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

function fakeReadySocket() {
  const sock = {
    authState: { creds: { me: { id: "972533144083:1@s.whatsapp.net" } } },
    sendMessage: async (_jid: string, _content: unknown) => ({ key: { id: `id-${Date.now()}-${Math.random()}` } }),
    sendPresenceUpdate: async () => {},
  };
  return sock as unknown as WASocket;
}

type FakeMsgOpts = { id?: string; fromMe: boolean; text: string; remoteJid?: string; remoteJidAlt?: string };

function fakeMessage(opts: FakeMsgOpts) {
  return {
    key: { id: opts.id, fromMe: opts.fromMe, remoteJid: opts.remoteJid, remoteJidAlt: opts.remoteJidAlt },
    message: { conversation: opts.text },
  } as Parameters<typeof handleMessagesUpsert>[0]["messages"][number];
}

function mockHandler() {
  const calls: { jid: string; text: string; meta?: MessageMeta }[] = [];
  const handler = (jid: string, text: string, meta?: MessageMeta) => calls.push({ jid, text, meta });
  return { handler, calls };
}

function resetAll() {
  _resetStateForTests();
  _resetCorrelationsForTests();
}

const PN = "972500000001@s.whatsapp.net";

async function main() {
  const sock = fakeReadySocket();
  setSocket(sock, "open");

  // ============================================================
  // חלק א׳ — client.ts / handleMessagesUpsert
  // ============================================================

  // 1. human fromMe:false → מעובד פעם אחת → correlation נוצר → תשובה אוטומטית אחת אפשרית
  resetAll();
  {
    const { handler, calls } = mockHandler();
    handleMessagesUpsert({ messages: [fakeMessage({ id: "HUM-1", fromMe: false, text: "בוקר טוב", remoteJid: PN })], type: "notify" }, sock, handler);
    check("1. הודעה אנושית (fromMe:false) → onMessage נקרא פעם אחת, עם correlationId", calls.length === 1 && !!calls[0]?.meta?.correlationId);
    if (calls[0]?.meta?.correlationId) {
      consumeCorrelationForReply(calls[0].meta.correlationId); // תשובה אוטומטית אחת — מותרת
      let threwOnSecond = false;
      try {
        consumeCorrelationForReply(calls[0].meta.correlationId);
      } catch (err) {
        threwOnSecond = err instanceof InvalidCorrelationError;
      }
      check("1b. אותו correlation לא ניתן לצריכה שנייה → תשובה אוטומטית שנייה חסומה", threwOnSecond);
    }
  }

  // 2. bot echo fromMe:true → נדחה מיידית, אין forward, אין correlation
  resetAll();
  {
    const { handler, calls } = mockHandler();
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "ECHO-1", fromMe: true, text: "בוקר טוב! מה אני יכול לעזור?", remoteJid: PN })], type: "notify" },
      sock,
      handler,
    );
    check("2. bot echo (fromMe:true) → onMessage לא נקרא בכלל (0 correlation, 0 קריאות ל-orchestrator)", calls.length === 0);
  }

  // 3. bot echo fromMe:true עם id/jid/text שונים בכל וריאציה — עדיין נדחה, לא תלוי בהם בכלל
  resetAll();
  {
    const { handler, calls } = mockHandler();
    const variants: FakeMsgOpts[] = [
      { id: "TOTALLY-DIFFERENT-ID", fromMe: true, text: "טקסט כלשהו", remoteJid: PN },
      { id: "X2", fromMe: true, text: "טקסט אחר", remoteJid: "555000111222@lid" }, // @lid
      { id: undefined, fromMe: true, text: "בלי id בכלל", remoteJid: PN }, // אין id
      { id: "X3", fromMe: true, text: "עם remoteJidAlt שונה", remoteJid: PN, remoteJidAlt: "666000@lid" },
      { id: "X4", fromMe: true, text: "" }, // בלי jid בכלל וגם טקסט ריק
    ];
    for (const v of variants) handleMessagesUpsert({ messages: [fakeMessage(v)], type: "notify" }, sock, handler);
    check(
      "3. echo עם כל שילוב id/jid/@lid/remoteJidAlt/text שונה → נדחה בכל המקרים, בלי תלות בהם",
      calls.length === 0,
      `onMessage נקרא ${calls.length} פעמים`,
    );
  }

  // 4. self-chat human command אמיתי (fromMe:true, לא echo כלל) → נדחה בכוונה — product decision, לא bug
  resetAll();
  {
    const { handler, calls } = mockHandler();
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "SELF-CHAT-REAL", fromMe: true, text: "סיימתי את המשימה, תעדכן במאנדיי", remoteJid: PN })], type: "notify" },
      sock,
      handler,
    );
    check(
      "4. פקודת self-chat אמיתית (fromMe:true, אף פעם לא נשלחה על ידינו) → נדחית בכוונה (OPTION SAFE — לא נתמך יותר, לא באג)",
      calls.length === 0,
    );
  }

  // 5. שתי הודעות אמיתיות (fromMe:false) → שני correlation נפרדים, תשובה אחת אפשרית לכל אחת
  resetAll();
  {
    const { handler, calls } = mockHandler();
    handleMessagesUpsert({ messages: [fakeMessage({ id: "HUM-2", fromMe: false, text: "הודעה א", remoteJid: PN })], type: "notify" }, sock, handler);
    handleMessagesUpsert({ messages: [fakeMessage({ id: "HUM-3", fromMe: false, text: "הודעה ב", remoteJid: PN })], type: "notify" }, sock, handler);
    const ids = calls.map((c) => c.meta?.correlationId);
    check(
      "5. שתי הודעות אנושיות נפרדות → שני correlationId שונים",
      calls.length === 2 && !!ids[0] && !!ids[1] && ids[0] !== ids[1],
      JSON.stringify(ids),
    );
  }

  // 6. duplicate inbound (fromMe:false) עם אותו message id → מעובד פעם אחת
  resetAll();
  {
    const { handler, calls } = mockHandler();
    const dup = fakeMessage({ id: "HUM-DUP", fromMe: false, text: "הודעה כפולה", remoteJid: PN });
    handleMessagesUpsert({ messages: [dup], type: "notify" }, sock, handler);
    handleMessagesUpsert({ messages: [dup], type: "notify" }, sock, handler);
    check("6. duplicate upsert של אותה הודעה בדיוק (אותו id) → onMessage נקרא פעם אחת בלבד", calls.length === 1, `נקרא ${calls.length} פעמים`);
  }

  // 7. reconnect/resync duplicate — socket חדש, אותו id → לא מטופל פעמיים
  resetAll();
  {
    const { handler, calls } = mockHandler();
    const msg = fakeMessage({ id: "HUM-RESYNC", fromMe: false, text: "הודעה לפני ניתוק", remoteJid: PN });
    handleMessagesUpsert({ messages: [msg], type: "notify" }, sock, handler);
    const newSock = fakeReadySocket(); // "reconnect" — socket חדש לגמרי
    handleMessagesUpsert({ messages: [msg], type: "notify" }, newSock, handler);
    check("7. resync אחרי reconnect (socket חדש) עם אותו id → לא מפעיל onMessage שוב", calls.length === 1, `נקרא ${calls.length} פעמים`);
  }

  // 8. proactive/outbox: נשלח בלי inbound correlation; ה-echo שלו (fromMe:true) לא יכול להיכנס ל-AI
  resetAll();
  {
    const { handler, calls } = mockHandler();
    const outboxJid = "972500000099@s.whatsapp.net";
    const body = `[טסט outbox] ${Date.now()}`;
    enqueueWhatsapp(outboxJid, body);
    try {
      await drainOnce(); // sendText גולמי — בלי correlation, בלי תלות ב-inbound כלל
      check("8a. הודעת outbox יזומה נשלחת בהצלחה בלי inbound correlation", true);
      handleMessagesUpsert(
        { messages: [fakeMessage({ id: "OUTBOX-ECHO", fromMe: true, text: body, remoteJid: outboxJid })], type: "notify" },
        sock,
        handler,
      );
      check("8b. echo של הודעת outbox (fromMe:true) → נדחה מיידית, לא נכנס ל-AI", calls.length === 0);
    } finally {
      db.prepare("DELETE FROM whatsapp_outbox WHERE body = ?").run(body);
    }
  }

  // 9a. circuit breaker per-jid עדיין עובד
  resetAll();
  {
    const { handler, calls } = mockHandler();
    const jidA = "972500000010@s.whatsapp.net";
    for (let i = 0; i < 6; i++) {
      handleMessagesUpsert({ messages: [fakeMessage({ id: `A-${i}`, fromMe: false, text: `הודעה ${i}`, remoteJid: jidA })], type: "notify" }, sock, handler);
    }
    check("9a. 6 הודעות 'חדשות' רצופות מאותו jid תוך שניות → per-jid breaker עוצר לפני ה-6 (סף 4)", calls.length > 0 && calls.length < 6, `${calls.length}/6`);

    // jid אחר, לא קשור, לא מושפע מה-breaker הספציפי (רק מה-global אם עברו שם את הסף)
    const jidB = "972500000011@s.whatsapp.net";
    const beforeB = calls.length;
    handleMessagesUpsert({ messages: [fakeMessage({ id: "B-1", fromMe: false, text: "הודעה ל-jid אחר", remoteJid: jidB })], type: "notify" }, sock, handler);
    check("9a-cont. jid אחר, לא קשור, עדיין מטופל (אם ה-global breaker לא נדלק תוך כך)", calls.length === beforeB + (isGloballyHalted() ? 0 : 1));
  }

  // 9b. circuit breaker גלובלי — halt בלי restart, מתאושש רק ע״י ניקוי מצב
  resetAll();
  {
    const { handler, calls } = mockHandler();
    check("9b-pre. לפני storm: לא ב-halt", !isGloballyHalted());
    for (let i = 0; i < 9; i++) {
      handleMessagesUpsert(
        { messages: [fakeMessage({ id: `SCATTERED-${i}`, fromMe: false, text: `הודעה ${i}`, remoteJid: `97250000${2000 + i}@s.whatsapp.net` })], type: "notify" },
        sock,
        handler,
      );
    }
    check("9b. 9 הודעות על 9 jid-ים שונים (per-jid לא תופס) → halt גלובלי נדלק", isGloballyHalted());

    const beforeHaltMore = calls.length;
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "DURING-HALT", fromMe: false, text: "עוד הודעה", remoteJid: "972500009999@s.whatsapp.net" })], type: "notify" },
      sock,
      handler,
    );
    check("9c. בזמן ה-halt: גם jid חדש לגמרי לא מתקבל", calls.length === beforeHaltMore);
  }

  // 10. אין process.exit ממגן ה-storm: התהליך הזה עצמו ממשיך לרוץ אחרי ה-halt (11a/9b) — ההוכחה
  //     שממשיכים לבצע עוד קוד טסט כרגיל, בלי exit; ה-recovery היחיד הוא ניקוי מצב מפורש.
  {
    _resetStateForTests();
    check("10. אחרי איפוס מצב מפורש (לא process.exit — לא קיים בקוד כלל) → halt מתבטל, בלי restart", !isGloballyHalted());
    const { handler, calls } = mockHandler();
    handleMessagesUpsert({ messages: [fakeMessage({ id: "AFTER-RESET", fromMe: false, text: "אחרי איפוס", remoteJid: PN })], type: "notify" }, sock, handler);
    check("10b. אחרי איפוס: onMessage שוב עובד כרגיל, בלי restart של התהליך", calls.length === 1);
  }

  // ============================================================
  // חלק ב׳ — replyCorrelation.ts: הוכחה שזו אכיפה, לא metadata
  // ============================================================
  resetAll();
  {
    const jid = "972500000005@s.whatsapp.net";
    const id1 = createInboundCorrelation(jid);
    consumeCorrelationForReply(id1);
    check("ב.1. correlation תקף נצרך בהצלחה בפעם הראשונה", true);

    let threwOnSecondConsume = false;
    try {
      consumeCorrelationForReply(id1);
    } catch (err) {
      threwOnSecondConsume = err instanceof InvalidCorrelationError;
    }
    check("ב.2. ניסיון שני לצרוך את אותו correlation → נכשל — אכיפה, לא רק tracing", threwOnSecondConsume);

    let threwOnMissing = false;
    try {
      consumeCorrelationForReply(undefined);
    } catch (err) {
      threwOnMissing = err instanceof InvalidCorrelationError;
    }
    check("ב.3. תשובה בלי correlationId בכלל → נדחית", threwOnMissing);

    const id2 = createInboundCorrelation(jid);
    const id3 = createInboundCorrelation(jid);
    check("ב.4. שני inbound נפרדים (אפילו לאותו jid) → שני correlation-ים עצמאיים", id2 !== id3);
    consumeCorrelationForReply(id2);
    consumeCorrelationForReply(id3);
    check("ב.5. כל correlation נצרך בהצלחה בעצמאות", true);
  }

  if (failed) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-reply-loop (OPTION SAFE) עברו ✅ (בלי חיבור אמיתי, בלי לגעת ב-auth/whatsapp)");
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, "test-whatsapp-reply-loop נכשל");
  process.exit(1);
});
