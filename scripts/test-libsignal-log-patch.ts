/**
 * בדיקת regression ל-patch על libsignal (patches/libsignal+6.0.0.patch): מוכיחה שהקריאות
 * המוכרות ל-console.info/console.warn ב-SessionRecord (closeSession/openSession/migrate/
 * removeOldSessions) לא יכולות יותר להדפיס session state גולמי (ephemeral/root/chain keys) —
 * האירוע שגרם למפתחות Signal אמיתיים להיכתב ל-production Docker logs.
 *
 * שתי שכבות בדיקה, כל אחת צריכה להיכשל על libsignal@6.0.0 לא-מתוקן:
 *   1. דינמית — קוראים בפועל ל-closeSession/openSession/removeOldSessions עם session מזויף
 *      שנושא sentinel ייחודי עמוק בפנים (מקום ה-ephemeralKeyPair.privKey/rootKey האמיתיים),
 *      לוכדים את כל קריאות console.info/warn בזמן הריצה, ומוכיחים שה-sentinel לא הגיע לשום
 *      קריאה. זו ההוכחה המשמעותית: היא לא תלויה בניסוח הטקסט, אלא בפועל שהאובייקט לא נדפס.
 *   2. סטטית — בדיקה משלימה וזולה שהשורות הידועות (כולל migrate, שלא נושא key material בעצמו)
 *      הוסרו מהקובץ המותקן בפועל.
 *
 *   npm run test:libsignal-log-patch
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import libsignalModule from "libsignal";
import { logger } from "../src/utils/logger.js";

const { SessionRecord } = libsignalModule as unknown as {
  SessionRecord: new () => {
    sessions: Record<string, unknown>;
    setSession(session: unknown): void;
    closeSession(session: unknown): void;
    openSession(session: unknown): void;
    removeOldSessions(): void;
  };
};
// migrate הוא static — נגיע אליו דרך ה-constructor עצמו, לא דרך instance.
const SessionRecordStatic = SessionRecord as unknown as {
  migrate(data: unknown): void;
};

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const SENTINEL = `SENTINEL_PRIVATE_KEY_${Math.random().toString(36).slice(2)}`;

function fakeSession(closed: number, sentinel = false) {
  return {
    indexInfo: {
      closed,
      baseKey: Buffer.from(`base-${closed}-${Math.random()}`),
      remoteIdentityKey: Buffer.from("not-a-real-identity-key"),
    },
    _chains: {},
    currentRatchet: {
      rootKey: sentinel ? Buffer.from(SENTINEL) : Buffer.from("root-key-placeholder"),
      ephemeralKeyPair: {
        pubKey: Buffer.from("pub-placeholder"),
        privKey: sentinel ? Buffer.from(SENTINEL) : Buffer.from("priv-placeholder"),
      },
    },
  };
}

/** מלכוד כל קריאה ל-console.info/console.warn בזמן ההרצה של fn, ומחזיר אותן בלי קשר לפלט בפועל. */
function captureConsole(fn: () => void): { level: "info" | "warn"; args: unknown[] }[] {
  const captured: { level: "info" | "warn"; args: unknown[] }[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = (...args: unknown[]) => {
    captured.push({ level: "info", args });
  };
  console.warn = (...args: unknown[]) => {
    captured.push({ level: "warn", args });
  };
  try {
    fn();
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
  return captured;
}

/** בודק שה-sentinel לא מגיע לשום קריאת console נלכדת, בכל עומק (לא רק ברמה הראשונה). */
function sentinelLeaked(captured: { args: unknown[] }[]): boolean {
  const seen = new Set<unknown>();
  function containsSentinel(value: unknown, depth: number): boolean {
    if (depth > 6 || value === null || value === undefined) return false;
    if (seen.has(value)) return false;
    if (typeof value === "string") return value.includes(SENTINEL);
    if (Buffer.isBuffer(value)) return value.toString("utf8").includes(SENTINEL) || value.includes(SENTINEL);
    if (typeof value === "object") {
      seen.add(value);
      for (const v of Object.values(value as Record<string, unknown>)) {
        if (containsSentinel(v, depth + 1)) return true;
      }
    }
    return false;
  }
  return captured.some((entry) => entry.args.some((a) => containsSentinel(a, 0)));
}

async function main() {
  logger.info("בודק patch על libsignal@6.0.0 — session-key logging (patches/libsignal+6.0.0.patch)");

  // --- 1. דינמי: closeSession על session פתוח שנושא sentinel במקום מפתחות אמיתיים ---
  {
    const record = new SessionRecord();
    const session = fakeSession(-1, true);
    const captured = captureConsole(() => record.closeSession(session));
    check(
      "1a. closeSession לא מדליף את ה-session (ephemeralKeyPair/rootKey) ל-console",
      !sentinelLeaked(captured),
      `נלכדו ${captured.length} קריאות console`,
    );
    check("1b. closeSession עדיין מסמן את ה-session כסגור (לוגיקה לא השתנתה)", typeof session.indexInfo.closed === "number" && session.indexInfo.closed !== -1);
  }

  // --- 2. דינמי: closeSession על session שכבר סגור (branch "Session already closed") ---
  {
    const record = new SessionRecord();
    const session = fakeSession(Date.now(), true);
    const captured = captureConsole(() => record.closeSession(session));
    check(
      '2a. closeSession על session סגור ("Session already closed") לא מדליף sentinel',
      !sentinelLeaked(captured),
      `נלכדו ${captured.length} קריאות console`,
    );
  }

  // --- 3. דינמי: openSession ---
  {
    const record = new SessionRecord();
    const session = fakeSession(Date.now(), true);
    const captured = captureConsole(() => record.openSession(session));
    check(
      "3a. openSession לא מדליף את ה-session ל-console",
      !sentinelLeaked(captured),
      `נלכדו ${captured.length} קריאות console`,
    );
    check("3b. openSession עדיין פותח את ה-session בפועל (לוגיקה לא השתנתה)", session.indexInfo.closed === -1);
  }

  // --- 4. דינמי: removeOldSessions — session ישן (עם sentinel) נדחק מעל הסף ---
  {
    const record = new SessionRecord();
    const CLOSED_SESSIONS_MAX = 40;
    const oldest = fakeSession(1, true); // closed=1 — העדכני ביותר (closed timestamp קטן ביותר)
    record.setSession(oldest);
    for (let i = 0; i < CLOSED_SESSIONS_MAX; i++) {
      record.setSession(fakeSession(1_000_000 + i, false));
    }
    const oldestKey = (oldest.indexInfo.baseKey as Buffer).toString("base64");
    check("4a. setup: יש יותר מ-CLOSED_SESSIONS_MAX sessions לפני הניקוי", Object.keys(record.sessions).length > CLOSED_SESSIONS_MAX);

    const captured = captureConsole(() => record.removeOldSessions());
    check(
      "4b. removeOldSessions לא מדליף את ה-session שהוסר (ephemeral/root key) ל-console",
      !sentinelLeaked(captured),
      `נלכדו ${captured.length} קריאות console`,
    );
    check("4c. removeOldSessions בפועל הסיר את ה-session הישן ביותר (לוגיקה לא השתנתה)", !(oldestKey in record.sessions));
  }

  // --- 5. דינמי: SessionRecord.migrate (static) — לא נושא key material, אבל השורה הידועה הוסרה ---
  {
    const captured = captureConsole(() =>
      SessionRecordStatic.migrate({ version: undefined, _sessions: { foo: { indexInfo: { closed: -1 } } } }),
    );
    const migrateLogFound = captured.some(
      (entry) => entry.level === "info" && entry.args.some((a) => typeof a === "string" && a.includes("Migrating session to")),
    );
    check('5a. SessionRecord.migrate לא כותב יותר "Migrating session to:" ל-console', !migrateLogFound);
  }

  // --- 6. סטטי: הקובץ המותקן בפועל לא מכיל את 5 השורות המסוכנות הידועות ---
  {
    const libsignalEntry = fileURLToPath(new URL("../node_modules/libsignal/src/session_record.js", import.meta.url));
    const source = readFileSync(libsignalEntry, "utf8");
    const dangerousSnippets = [
      'console.info("Closing session:"',
      'console.warn("Session already closed"',
      'console.info("Opening session:"',
      'console.warn("Session already open")',
      'console.info("Removing old closed session:"',
      'console.info("Migrating session to:"',
    ];
    for (const snippet of dangerousSnippets) {
      check(`6. ${path.basename(libsignalEntry)} לא מכיל: ${snippet}`, !source.includes(snippet));
    }
  }

  if (failed) {
    logger.error(`\n${failed} בדיקות נכשלו — ה-patch על libsignal לא מותקן/לא תקין (ייכשל על libsignal@6.0.0 נקי ולא-מתוקן)`);
    process.exit(1);
  }
  logger.info("\nכל בדיקות ה-patch ל-libsignal עברו ✅ — session state לא יכול להגיע ל-console.info/warn");
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, "test-libsignal-log-patch נכשל");
  process.exit(1);
});
