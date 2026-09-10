/**
 * בדיקת End-to-End של הלולאה על משימת בדיקה אמיתית ב-Monday.
 *
 *   Monday מזהה בעיה → הסוכן פונה לעובד → העובד עונה בשפה חופשית → הסוכן מבין →
 *   Monday מתעדכן → הסוכן ממשיך לעקוב.
 *
 * הרצה בשרת:  docker compose exec -T window node node_modules/tsx/dist/cli.mjs /app/data/e2e-loop.ts
 * ENV: E2E_KEEP=1 כדי לא למחוק את משימת הבדיקה בסוף (לצילום מסך של החלונית).
 *      E2E_CLEANUP_ONLY=<itemId> כדי רק לנקות ריצה קודמת.
 */

import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import { mondayRequest } from "../src/integrations/monday/client.js";
import { deleteTask } from "../src/integrations/monday/tasks.js";
import { runControlScan } from "../src/ops/controlScan.js";
import { runDailyControlCycle } from "../src/ops/escalation.js";
import { runOpsChat } from "../src/ops/chat.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { findingEvents, snoozedUntil } from "../src/db/repositories/findingEvents.js";
import { listUnseenNudges } from "../src/db/repositories/notifications.js";

const BOARD = "1550734526"; // משימות משרד כלליות
const YOCHI_MONDAY_ID = "71724151";
const TZ = "Asia/Jerusalem";
const now = DateTime.now().setZone(TZ);

const log = (s: string) => console.log(s);
const step = (n: number, s: string) => console.log(`\n━━━━━ שלב ${n}: ${s} ━━━━━`);
let fails = 0;
const assert = (label: string, cond: boolean, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fails++;
};

async function itemUpdates(itemId: string): Promise<string[]> {
  const r = await mondayRequest<{ items: { updates: { body: string }[] }[] }>(
    `query ($id:[ID!]) { items(ids:$id){ updates(limit:20){ body } } }`,
    { id: [itemId] },
  );
  return (r.items[0]?.updates ?? []).map((u) => u.body.replace(/<[^>]+>/g, "").trim());
}
async function itemCol(itemId: string, colId: string): Promise<string> {
  const r = await mondayRequest<{ items: { column_values: { id: string; text: string | null }[] }[] }>(
    `query ($id:[ID!]) { items(ids:$id){ column_values(ids:[$col]){ id text } } }`.replace("$col", `"${colId}"`),
    { id: [itemId] },
  );
  return r.items[0]?.column_values[0]?.text ?? "";
}

async function cleanup(itemId: string) {
  try {
    const keys = `('overdue:${itemId}','stuck:${itemId}','clientwait:${itemId}','verystale:${itemId}','blocking:${itemId}')`;
    db.exec(`DELETE FROM finding_events WHERE finding_key IN ${keys}`);
    db.exec(
      `DELETE FROM notifications WHERE item_id = '${itemId}' OR finding_key IN ${keys} OR body LIKE '%בדיקת לולאה E2E%'`,
    );
    db.exec(`DELETE FROM control_findings WHERE finding_key IN ${keys}`);
    await deleteTask(itemId);
    log(`  ניקוי: משימה ${itemId} נמחקה + רשומות DB נמחקו`);
  } catch (e) {
    log(`  ניקוי נכשל (ידני): ${(e as Error).message}`);
  }
}

async function main() {
  if (process.env.E2E_CLEANUP_ONLY) {
    await cleanup(process.env.E2E_CLEANUP_ONLY);
    return;
  }

  const yochi = resolveUserByKey("yochi")!;

  // ── שלב 1: Monday מזהה בעיה — משימת בדיקה שאיחרה ──
  step(1, "יצירת משימת בדיקה ב-Monday (אחראי: יוכי, תאריך יעד אתמול)");
  const yesterday = now.minus({ days: 1 }).toISODate()!;
  const name = `בדיקת לולאה E2E ${now.toFormat("dd/MM HH:mm")}`;
  const grp = await mondayRequest<{ boards: { groups: { id: string }[] }[] }>(
    `query { boards(ids:[${BOARD}]){ groups{ id } } }`,
  );
  const groupId = grp.boards[0]!.groups[0]!.id;
  const created = await mondayRequest<{ create_item: { id: string } }>(
    `mutation ($b:ID!,$g:String!,$n:String!,$v:JSON!) {
      create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$v){ id }
    }`,
    {
      b: BOARD,
      g: groupId,
      n: name,
      v: JSON.stringify({
        person: { personsAndTeams: [{ id: Number(YOCHI_MONDAY_ID), kind: "person" }] },
        status: { label: "לביצוע" },
        date4: { date: yesterday },
      }),
    },
  );
  const itemId = created.create_item.id;
  log(`  נוצרה משימה ${itemId} — "${name}", יעד ${yesterday}`);

  try {
    // ── שלב 2: הסריקה מזהה את הממצא ──
    step(2, "סריקת הבקרה מזהה את המשימה כבאיחור");
    const scan = await runControlScan();
    const finding = scan.findings.find((f) => f.key === `overdue:${itemId}`);
    assert("נוצר ממצא overdue_stale למשימה", !!finding, finding?.headline);
    assert("הממצא נושא itemId", finding?.itemId === itemId);
    assert("הממצא נושא itemSource=general", finding?.itemSource === "general");
    assert("האחראי בממצא = יוכי", (finding?.who ?? "").includes("Yochi") || (finding?.who ?? "").includes("יוכי"), finding?.who);

    // ── שלב 3: הסוכן פונה לעובד ──
    step(3, "הסבב היומי → הפנייה היזומה לעובד (מדמים יום עבודה אחד שעבר בלי תזוזה)");
    await runDailyControlCycle();
    // יום עבודה אחד אחורה → רמת הסלמה 1 בלבד (תזכורת לעובד), לא מסלים למוטי על משימת בדיקה.
    db.exec(
      `UPDATE control_findings SET first_seen = '${now.minus({ days: 1 }).toISO()}', escalation_level = 0 WHERE finding_key = 'overdue:${itemId}'`,
    );
    const cyc = await runDailyControlCycle();
    log(`  סבב: ${cyc.findings} ממצאים, ${cyc.escalations.length} הסלמות (כולל שאינן קשורות לבדיקה)`);
    const myEsc = cyc.escalations.filter((e) => e.headline.includes(name));
    assert("הסלמה של משימת הבדיקה = רמה 1 בלבד (תזכורת לעובד)", myEsc.length === 1 && myEsc[0]!.level === 1);

    const nudges = listUnseenNudges(yochi.key).filter((n) => n.itemId === itemId);
    assert("נוצרה פנייה יזומה (nudge) ליוכי על המשימה", nudges.length === 1);
    const nudge = nudges[0];
    log(`\n  📌 מה שהעובד רואה בחלון:\n     "${nudge?.body}"\n`);
    assert("הפנייה מקושרת ל-itemId + source", nudge?.itemId === itemId && nudge?.itemSource === "general");
    const evs1 = findingEvents(`overdue:${itemId}`);
    assert("נרשם finding_event: nudge_sent", evs1.some((e) => e.event === "nudge_sent"));

    // ── שלב 4: העובד עונה בשפה חופשית → הסוכן מבין → Monday מתעדכן ──
    step(4, 'העובד עונה: "צריך עוד יומיים, מחכה לאישור מהקונסטרוקטור"');
    const about = { itemId, source: "general" as const, findingKey: `overdue:${itemId}`, taskName: name };
    const reply1 = await runOpsChat(
      yochi,
      [{ role: "user", content: "צריך עוד יומיים, מחכה לאישור מהקונסטרוקטור" }],
      { about },
    );
    log(`  תשובת הסוכן: "${reply1.reply.replace(/\n/g, " ")}"`);
    log(`  פעולות: ${JSON.stringify(reply1.actions)}`);
    assert("הסוכן ביצע פעולה אחת (דחייה)", reply1.actions.length === 1 && /נדחה|📅/.test(reply1.actions[0] ?? ""));

    const in2 = now.plus({ days: 2 }).toISODate()!;
    const dateAfter = await itemCol(itemId, "date4");
    assert(`תאריך היעד ב-Monday עודכן ל-${in2}`, dateAfter === in2, `בפועל: ${dateAfter}`);
    const ups = await itemUpdates(itemId);
    assert("נוסף Update שמתעד את הדחייה", ups.some((u) => u.includes("נדחה") && u.includes("יוכי")), ups[0]?.slice(0, 80));
    const snz = snoozedUntil(`overdue:${itemId}`);
    assert(`finding_event snoozed עד ${in2}`, snz === in2, `בפועל: ${snz}`);

    // ── שלב 5: הסוכן ממשיך לעקוב — לא מסלים בזמן ההשהיה ──
    step(5, "סבב נוסף — הבקרה שקטה על המשימה כל עוד ההשהיה בתוקף");
    const nudgesBefore = listUnseenNudges(yochi.key).filter((n) => n.itemId === itemId).length;
    const cyc3 = await runDailyControlCycle();
    const nudgesAfter = listUnseenNudges(yochi.key).filter((n) => n.itemId === itemId).length;
    assert("לא נשלחה פנייה/הסלמה חדשה בזמן ההשהיה", nudgesAfter === nudgesBefore);
    const stillActive = db
      .prepare(`SELECT resolved_at FROM control_findings WHERE finding_key = 'overdue:${itemId}'`)
      .get() as { resolved_at: string | null } | undefined;
    assert("הממצא עדיין פעיל (ממשיכים לעקוב, לא נסגר)", !!stillActive && stillActive.resolved_at === null);
    void cyc3;

    // ── שלב 6: המעקב מתחדש כשההשהיה נגמרת ──
    step(6, "ההשהיה נגמרה (מדמים שעברו היומיים בלי תזוזה) → המעקב מתחדש");
    // גם התאריך שנדחה אליו עבר, וגם התגובה עצמה כבר ישנה — כלומר עבר יום עבודה בלי תזוזה מאז.
    db.exec(
      `UPDATE finding_events
         SET payload_json = json_set(payload_json,'$.snoozeUntil','${now.minus({ days: 2 }).toISODate()}'),
             created_at = '${now.minus({ days: 2 }).toFormat("yyyy-MM-dd HH:mm:ss")}'
       WHERE finding_key = 'overdue:${itemId}' AND event = 'snoozed'`,
    );
    db.exec(
      `UPDATE control_findings SET escalation_level = 0 WHERE finding_key = 'overdue:${itemId}'`,
    );
    const cyc4 = await runDailyControlCycle();
    const myEsc4 = cyc4.escalations.filter((e) => e.headline.includes(name));
    assert(
      "המעקב חזר — הסלמה חדשה אחרי שההשהיה נגמרה והמשימה עדיין לא זזה",
      myEsc4.length >= 1,
      myEsc4.map((e) => `רמה ${e.level}`).join(","),
    );

    // ── שלב 7: סגירת הלולאה — העובד מדווח שסיים ──
    step(7, 'העובד עונה: "סיימתי" → Monday מתעדכן לבוצע → הממצא נסגר');
    const reply2 = await runOpsChat(yochi, [{ role: "user", content: "סיימתי" }], { about });
    log(`  תשובת הסוכן: "${reply2.reply.replace(/\n/g, " ")}"`);
    log(`  פעולות: ${JSON.stringify(reply2.actions)}`);
    const statusAfter = await itemCol(itemId, "status");
    assert('סטטוס המשימה ב-Monday = "בוצע"', statusAfter === "בוצע", `בפועל: ${statusAfter}`);
    const evs2 = findingEvents(`overdue:${itemId}`);
    assert("נרשם finding_event: resolved_by_reply", evs2.some((e) => e.event === "resolved_by_reply"));
    const cyc5 = await runDailyControlCycle();
    const gone = !cyc5.escalations.some((e) => e.headline.includes(name));
    assert("הממצא לא מסלים יותר (הלולאה נסגרה)", gone);

    console.log(`\n${"═".repeat(50)}`);
    console.log(fails === 0 ? "🟢 כל שלבי הלולאה עברו End-to-End" : `🔴 ${fails} בדיקות נכשלו`);
    console.log("═".repeat(50));
  } finally {
    if (process.env.E2E_KEEP) {
      log(`\n(E2E_KEEP — משימת הבדיקה ${itemId} נשארה. לניקוי: E2E_CLEANUP_ONLY=${itemId})`);
      db.exec(`UPDATE notifications SET seen_at = NULL WHERE item_id = '${itemId}' AND kind = 'nudge'`);
    } else {
      log("");
      await cleanup(itemId);
    }
  }
  if (fails) process.exit(1);
}

main().catch((e) => {
  console.error("E2E נכשל:", e);
  process.exit(1);
});
