/**
 * הודעות צוות (שלב 1) — DB + repository + הרשאות. רץ על DB זמני מבודד בלבד (tests/setup).
 * מכסה: DM יחיד לזוג, idempotency (גם במקביל), פרטיות מול צד שלישי (כולל owner/admin), עריכה/מחיקה
 * רכה לשולח בלבד, תגובה מאותה שיחה, 4,000 תווים, markRead/unread, pagination + afterId, הרצה חוזרת של
 * הסכמה, foreign keys בפועל וגיבוי VACUUM INTO.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/db.js";
import { runDbBackup } from "../../src/ops/backup.js";
import {
  DELETED_PLACEHOLDER,
  TEAM_MESSAGE_MAX,
  TeamMessageError,
  deleteMessage,
  editMessage,
  listMessages,
  listThreads,
  markRead,
  openDm,
  sendMessage,
  unreadTotal,
} from "../../src/db/repositories/teamMessages.js";

// moti = owner, yochi = admin — שניהם חייבים להיחסם בשיחה שאינם חלק ממנה.
const A = "dov";
const B = "eitan";
const OWNER = "moti";
const ADMIN = "yochi";

function clean(): void {
  db.exec(`DELETE FROM team_messages`);
  db.exec(`DELETE FROM team_thread_members`);
  db.exec(`DELETE FROM team_threads`);
}

function expectCode(fn: () => unknown, code: string): TeamMessageError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TeamMessageError);
    expect((err as TeamMessageError).code).toBe(code);
    return err as TeamMessageError;
  }
  throw new Error(`ציפיתי לשגיאה ${code} ולא נזרקה`);
}

let n = 0;
const cid = () => `c-${++n}`;
function setup() {
  const { threadId } = openDm(A, B);
  return threadId;
}

beforeEach(clean);

describe("1-2. openDm", () => {
  it("פתיחה משני הכיוונים → שיחה אחת, שני חברים", () => {
    const first = openDm(A, B);
    const second = openDm(B, A);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM team_threads`).get() as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM team_thread_members`).get() as { c: number }).c).toBe(2);
  });

  it("לא עם עצמך ולא עם משתמש שאינו ב-TEAM_DIRECTORY", () => {
    expectCode(() => openDm(A, A), "invalid");
    expectCode(() => openDm(A, "nobody"), "invalid");
    expectCode(() => openDm("nobody", A), "invalid");
    expect((db.prepare(`SELECT COUNT(*) AS c FROM team_threads`).get() as { c: number }).c).toBe(0);
  });
});

describe("3. idempotency בשליחה", () => {
  it("אותו clientMessageId פעמיים → הודעה אחת, השנייה duplicate", () => {
    const t = setup();
    const id = cid();
    const r1 = sendMessage(A, t, "שלום", id);
    const r2 = sendMessage(A, t, "שלום", id);
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.message.id).toBe(r1.message.id);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM team_messages`).get() as { c: number }).c).toBe(1);
  });

  it("במקביל (Promise.all) → הודעה אחת בלבד", async () => {
    const t = setup();
    const id = cid();
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => sendMessage(A, t, "במקביל", id)),
    );
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM team_messages`).get() as { c: number }).c).toBe(1);
  });

  it("האילוץ נאכף במסד עצמו (INSERT גולמי כפול נדחה)", () => {
    const t = setup();
    const ins = db.prepare(
      `INSERT INTO team_messages (thread_id, sender_key, body, client_message_id) VALUES (?, ?, 'x', 'same')`,
    );
    ins.run(t, A);
    expect(() => ins.run(t, A)).toThrow(/UNIQUE/i);
    // אותו clientMessageId משולח אחר — מותר
    expect(() => db.prepare(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id) VALUES (?, ?, 'x', 'same')`).run(t, B)).not.toThrow();
  });

  it("clientMessageId חסר/ארוך מדי נדחה; השולח הוא תמיד me", () => {
    const t = setup();
    expectCode(() => sendMessage(A, t, "x", undefined), "invalid");
    expectCode(() => sendMessage(A, t, "x", ""), "invalid");
    expectCode(() => sendMessage(A, t, "x", "a".repeat(129)), "invalid");
    expect(sendMessage(B, t, "x", cid()).message.senderKey).toBe(B);
  });
});

describe("4. פרטיות — צד שלישי (כולל owner ו-admin)", () => {
  for (const outsider of [OWNER, ADMIN, "goldi"]) {
    it(`${outsider} לא יכול לקרוא/לשלוח/לערוך/למחוק/לסמן נקרא`, () => {
      const t = setup();
      const m = sendMessage(A, t, "סודי", cid()).message;

      expectCode(() => listMessages(outsider, t), "not_found");
      expectCode(() => listMessages(outsider, t, { afterId: 0 }), "not_found");
      expectCode(() => sendMessage(outsider, t, "פריצה", cid()), "not_found");
      expectCode(() => editMessage(outsider, m.id, "ערוך"), "not_found");
      expectCode(() => deleteMessage(outsider, m.id), "not_found");
      expectCode(() => markRead(outsider, t, m.id), "not_found");

      expect(listThreads(outsider)).toEqual([]);
      expect(unreadTotal(outsider)).toBe(0);
      // ושום דבר לא השתנה
      expect(listMessages(A, t).messages[0]!.body).toBe("סודי");
      expect((db.prepare(`SELECT COUNT(*) AS c FROM team_messages`).get() as { c: number }).c).toBe(1);
    });
  }

  it("שיחה שלא קיימת ושיחה זרה → אותה שגיאה בדיוק (בלי לחשוף קיום)", () => {
    const t = setup();
    const m = sendMessage(A, t, "x", cid()).message;
    const foreign = [
      expectCode(() => listMessages(OWNER, t), "not_found"),
      expectCode(() => sendMessage(OWNER, t, "x", cid()), "not_found"),
      expectCode(() => markRead(OWNER, t, 1), "not_found"),
      expectCode(() => editMessage(OWNER, m.id, "x"), "not_found"),
    ];
    const missing = [
      expectCode(() => listMessages(OWNER, 99999), "not_found"),
      expectCode(() => sendMessage(OWNER, 99999, "x", cid()), "not_found"),
      expectCode(() => markRead(OWNER, 99999, 1), "not_found"),
      expectCode(() => editMessage(OWNER, 99999, "x"), "not_found"),
    ];
    for (const e of [...foreign, ...missing]) expect(e.message).toBe(foreign[0]!.message);
  });
});

describe("5-8. עריכה ומחיקה", () => {
  it("רק השולח רשאי לערוך ולמחוק (גם הצד השני בשיחה נדחה)", () => {
    const t = setup();
    const m = sendMessage(A, t, "שלי", cid()).message;
    expectCode(() => editMessage(B, m.id, "שלך"), "forbidden");
    expectCode(() => deleteMessage(B, m.id), "forbidden");
    expect(listMessages(A, t).messages[0]!.body).toBe("שלי");
    expect(listMessages(A, t).messages[0]!.deleted).toBe(false);
  });

  it("עריכה מעדכנת edited_at ושומרת id/שולח/created_at", () => {
    const t = setup();
    const m = sendMessage(A, t, "לפני", cid()).message;
    expect(m.editedAt).toBeNull();
    const e = editMessage(A, m.id, "  אחרי  ");
    expect(e.body).toBe("אחרי");
    expect(e.editedAt).not.toBeNull();
    expect(e.id).toBe(m.id);
    expect(e.senderKey).toBe(m.senderKey);
    expect(e.createdAt).toBe(m.createdAt);
    expect(e.threadId).toBe(m.threadId);
  });

  it("מחיקה רכה: deleted_at נקבע, התוכן מוסתר ב-API אך נשאר ב-DB", () => {
    const t = setup();
    const m = sendMessage(A, t, "תוכן מקורי", cid()).message;
    const d = deleteMessage(A, m.id);
    expect(d.deleted).toBe(true);
    expect(d.deletedAt).not.toBeNull();
    expect(d.body).toBe(DELETED_PLACEHOLDER);
    const listed = listMessages(B, t).messages[0]!;
    expect(listed.body).toBe(DELETED_PLACEHOLDER);
    expect(JSON.stringify(listThreads(B))).not.toContain("תוכן מקורי");
    const raw = db.prepare(`SELECT body, deleted_at FROM team_messages WHERE id = ?`).get(m.id) as { body: string; deleted_at: string };
    expect(raw.body).toBe("תוכן מקורי");
    expect(raw.deleted_at).not.toBeNull();
  });

  it("הודעה מחוקה לא ניתנת לעריכה ולא למחיקה חוזרת; deleted_at לא זז", () => {
    const t = setup();
    const m = sendMessage(A, t, "x", cid()).message;
    const d = deleteMessage(A, m.id);
    expectCode(() => editMessage(A, m.id, "חי"), "deleted");
    expectCode(() => deleteMessage(A, m.id), "deleted");
    expect(listMessages(A, t).messages[0]!.deletedAt).toBe(d.deletedAt);
  });

  it("תצוגה מקדימה של תגובה להודעה מחוקה לא מדליפה את התוכן", () => {
    const t = setup();
    const orig = sendMessage(A, t, "תוכן סודי", cid()).message;
    sendMessage(B, t, "תגובה", cid(), orig.id);
    deleteMessage(A, orig.id);
    const reply = listMessages(B, t).messages[1]!;
    expect(reply.replyTo).toMatchObject({ id: orig.id, deleted: true, preview: DELETED_PLACEHOLDER });
  });
});

describe("9. תגובה (reply)", () => {
  it("תגובה להודעה באותה שיחה — מותר, עם ציטוט", () => {
    const t = setup();
    const orig = sendMessage(A, t, "שאלה", cid()).message;
    const r = sendMessage(B, t, "תשובה", cid(), orig.id).message;
    expect(r.replyTo).toMatchObject({ id: orig.id, senderKey: A, preview: "שאלה", deleted: false });
  });

  it("תגובה להודעה משיחה אחרת, או למזהה לא קיים — נדחית", () => {
    const t1 = setup();
    const { threadId: t2 } = openDm("dov", "ruchama");
    const other = sendMessage("dov", t2, "בשיחה אחרת", cid()).message;
    expectCode(() => sendMessage(A, t1, "x", cid(), other.id), "invalid");
    expectCode(() => sendMessage(A, t1, "x", cid(), 99999), "invalid");
    expect((db.prepare(`SELECT COUNT(*) AS c FROM team_messages WHERE thread_id = ?`).get(t1) as { c: number }).c).toBe(0);
  });

  it("ה-DB עצמו דוחה תגובה חוצת-שיחות (FK מרוכב)", () => {
    const t1 = setup();
    const { threadId: t2 } = openDm("dov", "ruchama");
    const other = sendMessage("dov", t2, "x", cid()).message;
    expect(() =>
      db
        .prepare(`INSERT INTO team_messages (thread_id, sender_key, body, reply_to_id, client_message_id) VALUES (?, ?, 'x', ?, 'raw')`)
        .run(t1, A, other.id),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("10. מגבלת אורך", () => {
  it("4,000 תווים מותר; 4,001 נדחה — בשליחה ובעריכה; ריק נדחה", () => {
    const t = setup();
    const ok = sendMessage(A, t, "א".repeat(TEAM_MESSAGE_MAX), cid()).message;
    expectCode(() => sendMessage(A, t, "א".repeat(TEAM_MESSAGE_MAX + 1), cid()), "invalid");
    expectCode(() => sendMessage(A, t, "   ", cid()), "invalid");
    expectCode(() => sendMessage(A, t, 42, cid()), "invalid");
    expect(editMessage(A, ok.id, "ב".repeat(TEAM_MESSAGE_MAX)).body.length).toBe(TEAM_MESSAGE_MAX);
    expectCode(() => editMessage(A, ok.id, "ב".repeat(TEAM_MESSAGE_MAX + 1)), "invalid");
    expectCode(() => editMessage(A, ok.id, ""), "invalid");
    expect(listMessages(A, t).messages[0]!.body).toBe("ב".repeat(TEAM_MESSAGE_MAX));
  });
});

describe("11. markRead ו-unread", () => {
  it("מונה רק הודעות של אחרים, לא מחוקות, אחרי last_read", () => {
    const t = setup();
    const m1 = sendMessage(A, t, "1", cid()).message;
    sendMessage(A, t, "2", cid());
    const m3 = sendMessage(A, t, "3", cid()).message;
    sendMessage(B, t, "של B", cid());
    expect(unreadTotal(B)).toBe(3);
    expect(unreadTotal(A)).toBe(1);
    expect(listThreads(B)[0]!.unread).toBe(3);

    deleteMessage(A, m3.id);
    expect(unreadTotal(B)).toBe(2);

    expect(markRead(B, t, m1.id)).toBe(m1.id);
    expect(unreadTotal(B)).toBe(1);
  });

  it("מתקדם בלבד — לא חוזר אחורה, ולא מעבר להודעה האחרונה", () => {
    const t = setup();
    const m1 = sendMessage(A, t, "1", cid()).message;
    const m2 = sendMessage(A, t, "2", cid()).message;
    expect(markRead(B, t, m2.id)).toBe(m2.id);
    expect(markRead(B, t, m1.id)).toBe(m2.id); // לא חוזר אחורה
    expect(markRead(B, t, 1_000_000)).toBe(m2.id); // נחתך להודעה האחרונה
    sendMessage(A, t, "3", cid());
    expect(unreadTotal(B)).toBe(1);
    expectCode(() => markRead(B, t, -1), "invalid");
    expectCode(() => markRead(B, t, 1.5), "invalid");
  });

  it("מצב הקריאה נפרד מ-notifications (לא נוגע בטבלה)", () => {
    const before = (db.prepare(`SELECT COUNT(*) AS c FROM notifications`).get() as { c: number }).c;
    const t = setup();
    const m = sendMessage(A, t, "x", cid()).message;
    markRead(B, t, m.id);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM notifications`).get() as { c: number }).c).toBe(before);
  });
});

describe("12. pagination ו-afterId", () => {
  it("העמוד האחרון, דפדוף אחורה עם beforeId, ו-hasMore", () => {
    const t = setup();
    const ids = Array.from({ length: 7 }, (_, i) => sendMessage(A, t, `m${i}`, cid()).message.id);
    const p1 = listMessages(B, t, { limit: 3 });
    expect(p1.messages.map((m) => m.body)).toEqual(["m4", "m5", "m6"]);
    expect(p1.hasMore).toBe(true);
    const p2 = listMessages(B, t, { limit: 3, beforeId: p1.messages[0]!.id });
    expect(p2.messages.map((m) => m.body)).toEqual(["m1", "m2", "m3"]);
    expect(p2.hasMore).toBe(true);
    const p3 = listMessages(B, t, { limit: 3, beforeId: p2.messages[0]!.id });
    expect(p3.messages.map((m) => m.body)).toEqual(["m0"]);
    expect(p3.hasMore).toBe(false);
    expect(ids).toHaveLength(7);
  });

  it("afterId משלים בדיוק את החסרות, בסדר עולה, בלי כפילות", () => {
    const t = setup();
    const m0 = sendMessage(A, t, "m0", cid()).message;
    sendMessage(A, t, "m1", cid());
    sendMessage(B, t, "m2", cid());
    sendMessage(A, t, "m3", cid());
    const missed = listMessages(B, t, { afterId: m0.id, limit: 2 });
    expect(missed.messages.map((m) => m.body)).toEqual(["m1", "m2"]);
    expect(missed.hasMore).toBe(true);
    const rest = listMessages(B, t, { afterId: missed.messages[1]!.id });
    expect(rest.messages.map((m) => m.body)).toEqual(["m3"]);
    expect(rest.hasMore).toBe(false);
    expect(listMessages(B, t, { afterId: rest.messages[0]!.id }).messages).toEqual([]);
    expectCode(() => listMessages(B, t, { afterId: 1, beforeId: 5 }), "invalid");
  });
});

describe("13. סכמה", () => {
  it("ניתנת להרצה חוזרת ללא שגיאה ולא מוחקת נתונים", () => {
    const t = setup();
    sendMessage(A, t, "נשאר", cid());
    const schema = fs.readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf-8");
    expect(() => db.exec(schema)).not.toThrow();
    expect(listMessages(A, t).messages).toHaveLength(1);
  });

  it("מבנה מוכן לקבוצות: kind + dm_key אופציונלי לקבוצה, DM בלי dm_key נדחה", () => {
    expect(() => db.prepare(`INSERT INTO team_threads (kind, dm_key, created_by) VALUES ('dm', NULL, 'x')`).run()).toThrow(/CHECK/i);
    expect(() => db.prepare(`INSERT INTO team_threads (kind, dm_key, title, created_by) VALUES ('group', NULL, 'צוות', 'x')`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO team_threads (kind, dm_key, created_by) VALUES ('other', 'k', 'x')`).run()).toThrow(/CHECK/i);
  });
});

describe("14. Foreign Keys", () => {
  it("PRAGMA foreign_keys מופעל בפועל בחיבור", () => {
    expect((db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });

  it("הודעה/חבר בשיחה שאינה קיימת נדחים", () => {
    expect(() => db.prepare(`INSERT INTO team_messages (thread_id, sender_key, body, client_message_id) VALUES (999, 'dov', 'x', 'k')`).run()).toThrow(/FOREIGN KEY/i);
    expect(() => db.prepare(`INSERT INTO team_thread_members (thread_id, user_key) VALUES (999, 'dov')`).run()).toThrow(/FOREIGN KEY/i);
  });

  it("אי אפשר למחוק פיזית שיחה שיש בה הודעות", () => {
    const t = setup();
    sendMessage(A, t, "x", cid());
    expect(() => db.prepare(`DELETE FROM team_threads WHERE id = ?`).run(t)).toThrow(/FOREIGN KEY/i);
  });
});

describe("15. גיבוי", () => {
  it("גיבוי SQLite (runDbBackup / VACUUM INTO) מכיל את הטבלאות והנתונים ועקבי", () => {
    const t = setup();
    const m = sendMessage(A, t, "בגיבוי", cid()).message;
    sendMessage(B, t, "תגובה", cid(), m.id);
    markRead(B, t, m.id);
    deleteMessage(B, listMessages(B, t).messages[1]!.id);

    // runDbBackup כותב ל-data/backups יחסית ל-cwd — מפנים זמנית לתיקיית temp כדי לא לגעת בריפו.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "team-backup-"));
    const prevCwd = process.cwd();
    let file: string;
    try {
      process.chdir(tmp);
      file = path.join(tmp, runDbBackup().file);
    } finally {
      process.chdir(prevCwd);
    }

    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = (copy.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(["team_threads", "team_thread_members", "team_messages"]));
      const q = (sql: string) => copy.prepare(sql).all() as Record<string, unknown>[];
      expect(q(`SELECT COUNT(*) AS c FROM team_threads`)[0]!.c).toBe(1);
      expect(q(`SELECT COUNT(*) AS c FROM team_thread_members`)[0]!.c).toBe(2);
      expect(q(`SELECT COUNT(*) AS c FROM team_messages`)[0]!.c).toBe(2);
      expect(q(`SELECT body FROM team_messages WHERE id = ${m.id}`)[0]!.body).toBe("בגיבוי");
      expect(q(`SELECT COUNT(*) AS c FROM team_messages WHERE deleted_at IS NOT NULL`)[0]!.c).toBe(1);
      expect(q(`SELECT last_read_message_id AS v FROM team_thread_members WHERE user_key = 'eitan'`)[0]!.v).toBe(m.id);
      // עקביות: אין הפרות FK, והמסד תקין
      expect(q(`PRAGMA foreign_key_check`)).toEqual([]);
      expect(q(`PRAGMA integrity_check`)[0]!.integrity_check).toBe("ok");
    } finally {
      copy.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
