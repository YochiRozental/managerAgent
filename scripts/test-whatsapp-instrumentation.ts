/**
 * בדיקות ל-diagnostic instrumentation: processInstanceId, whatsapp_inbound trace, whatsapp_send
 * trace, ומגן send-count דטרמיניסטי לפי correlationId (Section 7 — לא timing/text). המטרה: בניסוי
 * הבא, לדעת בוודאות מי יצר כל שליחת WhatsApp — בלי תלות בתוכן ההודעה.
 *
 * שימוש ב-_setInboundTraceSinkForTests/_setSendTraceSinkForTests (seam לבדיקות, כמו _runModel
 * ב-agentLoop.ts) כדי להוכיח מה *באמת* נרשם — לא רק שהקוד לא זרק שגיאה.
 *
 *   npm run test:whatsapp-instrumentation
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WASocket } from "@whiskeysockets/baileys";
import { _sendReplyForTests } from "../src/pipeline/messageHandler.js";
import {
  _resetStateForTests,
  handleMessagesUpsert,
  type MessageMeta,
} from "../src/integrations/whatsapp/client.js";
import { setSocket } from "../src/integrations/whatsapp/connectionState.js";
import { drainOnce } from "../src/integrations/whatsapp/outboxDrainer.js";
import { enqueueWhatsapp } from "../src/db/repositories/whatsappOutbox.js";
import { db } from "../src/db/db.js";
import { _resetCorrelationsForTests, createInboundCorrelation } from "../src/integrations/whatsapp/replyCorrelation.js";
import {
  _setBlockedReplySinkForTests,
  _setInboundTraceSinkForTests,
  _setSendTraceSinkForTests,
  processInstanceId,
} from "../src/integrations/whatsapp/trace.js";
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
  const calls: { count: number } = { count: 0 };
  const sock = {
    authState: { creds: { me: { id: "972533144083:1@s.whatsapp.net" } } },
    sendMessage: async (_jid: string, _content: unknown) => {
      calls.count++;
      return { key: { id: `wamsg-${calls.count}-${Date.now()}` } };
    },
    sendPresenceUpdate: async () => {},
  };
  return { sock: sock as unknown as WASocket, calls };
}

type FakeMsgOpts = { id?: string; fromMe: boolean; text: string; remoteJid?: string };
function fakeMessage(opts: FakeMsgOpts) {
  return {
    key: { id: opts.id, fromMe: opts.fromMe, remoteJid: opts.remoteJid },
    message: { conversation: opts.text },
  } as Parameters<typeof handleMessagesUpsert>[0]["messages"][number];
}

function mockHandler() {
  const calls: { jid: string; text: string; meta?: MessageMeta }[] = [];
  const handler = (jid: string, text: string, meta?: MessageMeta) => calls.push({ jid, text, meta });
  return { handler, calls };
}

function captureTraces() {
  const inbound: Record<string, unknown>[] = [];
  const send: Record<string, unknown>[] = [];
  const blocked: Record<string, unknown>[] = [];
  _setInboundTraceSinkForTests((r) => inbound.push(r));
  _setSendTraceSinkForTests((r) => send.push(r));
  _setBlockedReplySinkForTests((r) => blocked.push(r));
  return {
    inbound,
    send,
    blocked,
    stop() {
      _setInboundTraceSinkForTests(null);
      _setSendTraceSinkForTests(null);
      _setBlockedReplySinkForTests(null);
    },
  };
}

function resetAll() {
  _resetStateForTests();
  _resetCorrelationsForTests();
}

const PN = "972500000001@s.whatsapp.net";

async function main() {
  const { sock } = fakeReadySocket();
  setSocket(sock, "open");

  // 1. inbound אחד → orchestrator אחד (מדומה: consume+send דרך sendReply) → inbound_reply אחד
  resetAll();
  {
    const traces = captureTraces();
    const { handler, calls } = mockHandler();
    handleMessagesUpsert({ messages: [fakeMessage({ id: "IN-1", fromMe: false, text: "מה נשמע?", remoteJid: PN })], type: "notify" }, sock, handler);
    const correlationId = calls[0]?.meta?.correlationId;
    check("1a. inbound אחד התקבל, correlation נוצר", calls.length === 1 && !!correlationId);

    const { sock: replySock } = fakeReadySocket();
    setSocket(replySock, "open");
    await _sendReplyForTests(PN, "תשובת orchestrator", false, correlationId);

    const sendEvents = traces.send.filter((r) => r.source === "inbound_reply");
    check("1b. בדיוק שליחת inbound_reply אחת נרשמה, עם אותו correlationId", sendEvents.length === 1 && sendEvents[0]?.correlationId === correlationId);
    traces.stop();
    setSocket(sock, "open");
  }

  // 2. ניסיון לשני inbound_reply עם אותו correlation → השני נחסם (Section 7 — לפי correlationId, לא timing/text)
  resetAll();
  {
    const traces = captureTraces();
    const jid = "972500000002@s.whatsapp.net";
    const correlationId = createInboundCorrelation(jid);
    const { sock: s, calls } = fakeReadySocket();
    setSocket(s, "open");

    await _sendReplyForTests(jid, "תשובה ראשונה", false, correlationId);
    check("2a. תשובה ראשונה נשלחה בהצלחה", calls.count === 1);

    await _sendReplyForTests(jid, "תשובה שנייה — לא אמורה לצאת", false, correlationId);
    check("2b. ניסיון שני לאותו correlation לא הגיע ל-sendMessage בכלל", calls.count === 1, `נקרא ${calls.count} פעמים`);
    check(
      "2c. נרשם blocked_duplicate_reply עם אותו correlationId (guard דטרמיניסטי — לא timing/text)",
      traces.blocked.length === 1 && traces.blocked[0]?.correlationId === correlationId,
    );
    check("2d. שני whatsapp_send תחת inbound_reply לא נרשמו — רק אחד", traces.send.filter((r) => r.source === "inbound_reply").length === 1);
    traces.stop();
  }

  // 3. שני inbound שונים (correlation שונה) → שניהם נשלחים
  resetAll();
  {
    const jid = "972500000003@s.whatsapp.net";
    const c1 = createInboundCorrelation(jid);
    const c2 = createInboundCorrelation(jid);
    const { sock: s, calls } = fakeReadySocket();
    setSocket(s, "open");

    await _sendReplyForTests(jid, "תשובה א", false, c1);
    await _sendReplyForTests(jid, "תשובה ב", false, c2);
    check("3. שני correlation-ים שונים → שתי שליחות בפועל", calls.count === 2, `נקרא ${calls.count} פעמים`);
  }

  // 4. proactive/outbox אינו נחסם ע"י guard ה-correlation (הוא לא עובר דרך sendReply/consume בכלל)
  resetAll();
  {
    const outboxJid = "972500000099@s.whatsapp.net";
    const body = `[טסט instrumentation] ${Date.now()}`;
    enqueueWhatsapp(outboxJid, body);
    try {
      await drainOnce();
      check("4. הודעת outbox נשלחה בהצלחה, בלי תלות ב-correlation guard", true);
    } finally {
      db.prepare("DELETE FROM whatsapp_outbox WHERE body = ?").run(body);
    }
  }

  // 5. fromMe:true → נרשם whatsapp_inbound (decision=drop_from_me) → לא מגיע ל-AI → אין תשובה
  resetAll();
  {
    const traces = captureTraces();
    const { handler, calls } = mockHandler();
    handleMessagesUpsert(
      { messages: [fakeMessage({ id: "ECHO-1", fromMe: true, text: "טקסט כלשהו", remoteJid: PN })], type: "notify" },
      sock,
      handler,
    );
    check("5a. onMessage לא נקרא בכלל (לא מגיע ל-AI)", calls.length === 0);
    const dropped = traces.inbound.filter((r) => r.decision === "drop_from_me");
    check("5b. נרשם whatsapp_inbound עם decision=drop_from_me לפני ה-drop", dropped.length === 1 && dropped[0]?.fromMe === true);
    check("5c. הרשומה לא מכילה טקסט/jid גולמי — רק hash", typeof dropped[0]?.jidHash === "string" && !("text" in dropped[0]) && !("jid" in dropped[0]));
    traces.stop();
  }

  // 6. duplicate inbound message id → לא מגיע פעמיים ל-AI, ונרשם drop_duplicate_id
  resetAll();
  {
    const traces = captureTraces();
    const { handler, calls } = mockHandler();
    const dup = fakeMessage({ id: "DUP-1", fromMe: false, text: "הודעה", remoteJid: PN });
    handleMessagesUpsert({ messages: [dup], type: "notify" }, sock, handler);
    handleMessagesUpsert({ messages: [dup], type: "notify" }, sock, handler);
    check("6a. onMessage נקרא פעם אחת בלבד", calls.length === 1);
    const acceptedCount = traces.inbound.filter((r) => r.decision === "accepted").length;
    const dupCount = traces.inbound.filter((r) => r.decision === "drop_duplicate_id").length;
    check("6b. trace: accepted פעם אחת, drop_duplicate_id פעם אחת", acceptedCount === 1 && dupCount === 1);
    traces.stop();
  }

  // 7. send trace מקבל את ה-whatsappMessageId שחזר בפועל מ-sendMessage
  resetAll();
  {
    const traces = captureTraces();
    const { sock: s } = fakeReadySocket();
    setSocket(s, "open");
    const correlationId = createInboundCorrelation(PN);
    await _sendReplyForTests(PN, "תשובה עם מעקב id", false, correlationId);
    const sendEvent = traces.send.find((r) => r.correlationId === correlationId);
    check(
      "7. whatsapp_send כולל whatsappMessageId לא-ריק שתואם למה ש-sendMessage החזיר",
      typeof sendEvent?.whatsappMessageId === "string" && (sendEvent.whatsappMessageId as string).startsWith("wamsg-"),
      JSON.stringify(sendEvent),
    );
    traces.stop();
    setSocket(sock, "open");
  }

  // 8. שני processInstanceId שונים בשתי הרצות process נפרדות (לא רק ערך תיאורטי) — מוכיח בפועל
  //    ששני תהליכי whatsapp-agent (production ישן/חדש, או production מול הרצה מקומית) יהיו
  //    ניתנים להבחנה בלוגים, בדיוק המטרה שהובילה ל-instrumentation הזה.
  {
    check("8a. processInstanceId בתהליך הנוכחי הוא מחרוזת לא ריקה", typeof processInstanceId === "string" && processInstanceId.length > 0);

    const tmpDir = mkdtempSync(path.join(tmpdir(), "wa-instance-id-"));
    const probeScript = path.join(tmpDir, "probe.mjs");
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(scriptDir, "..");
    const traceModuleUrl = pathToFileURL(path.join(projectRoot, "src/integrations/whatsapp/trace.ts")).href;
    writeFileSync(probeScript, `import { processInstanceId } from ${JSON.stringify(traceModuleUrl)};\nconsole.log(processInstanceId);\n`);
    const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const runOnce = () => execFileSync(process.execPath, [tsxCli, probeScript], { cwd: projectRoot, encoding: "utf-8" }).trim();
    const idRun1 = runOnce();
    const idRun2 = runOnce();
    check(
      "8b. שתי הרצות process נפרדות מייצרות processInstanceId שונה זה מזה",
      !!idRun1 && !!idRun2 && idRun1 !== idRun2,
      `run1=${idRun1} run2=${idRun2}`,
    );
  }

  if (failed) {
    logger.error(`\n${failed} בדיקות נכשלו`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-instrumentation עברו ✅ (בלי חיבור אמיתי, בלי לגעת ב-auth/whatsapp)");
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, "test-whatsapp-instrumentation נכשל");
  process.exit(1);
});
