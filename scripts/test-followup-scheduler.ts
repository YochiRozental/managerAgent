/**
 * חיבור runDueFollowups למתזמן — audit 2026-09-16: חלון עבודה (08:30–17:30, Asia/Jerusalem),
 * catch-up ב-startup (מיידי בתוך החלון, שקט בלילה), מניעת overlap, בידוד כשל פר-item, ו-timer
 * שלא נשאר יתום. DB אמיתי (מקומי), אפס Monday אמיתי, אפס timer אמיתי שממתין 15 דקות.
 *
 *   npm run test:followup-scheduler
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { env } from "../src/config/env.js";
import { db } from "../src/db/db.js";
import { upsertFinding } from "../src/db/repositories/controlFindings.js";
import { getFollowup } from "../src/db/repositories/controlFollowups.js";
import { scheduleCommitmentCheck, type FollowupRunnerDeps } from "../src/ops/followups.js";
import {
  FOLLOWUP_SCHEDULE_CONFIG,
  isWithinFollowupWindow,
  maybeRunFollowupCatchUpOnStartup,
  runFollowupCycle,
  startFollowupSchedule,
  stopFollowupSchedule,
} from "../src/ops/scheduler.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

// 2026-09-14 = יום שני (חושב מראש). 2026-09-18 = יום שישי של אותו שבוע.
const monday10 = DateTime.fromObject({ year: 2026, month: 9, day: 14, hour: 10, minute: 0 }, { zone: "Asia/Jerusalem" });
const monday07 = monday10.set({ hour: 7 });
const monday18 = monday10.set({ hour: 18 });
const monday11 = monday10.set({ hour: 11 });
const monday22 = monday10.set({ hour: 22 });
const friday10 = DateTime.fromObject({ year: 2026, month: 9, day: 18, hour: 10, minute: 0 }, { zone: "Asia/Jerusalem" });

function cleanup(): void {
  db.exec(`DELETE FROM control_followups WHERE item_id LIKE '%__sched_%'`);
  db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '%__sched_%'`);
  db.exec(`DELETE FROM control_findings WHERE item_id LIKE '%__sched_%'`);
  db.exec(`DELETE FROM notifications WHERE item_id LIKE '%__sched_%'`);
}
cleanup();

function seedFinding(itemId: string): string {
  const findingKey = `overdue:${itemId}`;
  upsertFinding({
    findingKey,
    kind: "overdue_stale",
    severity: "high",
    who: "דוב שפירא",
    headline: "בדיקת scheduler",
    detail: "בדיקה",
    itemId,
    itemSource: "general",
    dueDate: "2026-09-10",
    now: monday10.toISO()!,
  });
  return findingKey;
}

function makeDueFollowup(itemId: string, commitmentDateISO: string, dueAtOverrideISO?: string) {
  const findingKey = seedFinding(itemId);
  const f = scheduleCommitmentCheck({ itemId, itemSource: "general", findingKey, userKey: "dov", commitmentDateISO });
  if (dueAtOverrideISO) {
    db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(dueAtOverrideISO, f.id);
  }
  return f;
}

const okDeps = (label: string): FollowupRunnerDeps => ({
  getTaskStatusLabel: async () => label,
  addNotification: () => 1,
  publishNudge: () => {},
});

// ─────────────────────────────────────────────────────────────────────────────
// 1-3. חלון העבודה — pure, בלי clock אמיתי
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 1-3. isWithinFollowupWindow ──");
{
  check("10:00 שני (בתוך שעות העבודה) → מותר", isWithinFollowupWindow(monday10) === true);
  check("07:00 שני (לפני 08:30) → לא רץ", isWithinFollowupWindow(monday07) === false);
  check("18:00 שני (אחרי 17:30) → לא רץ", isWithinFollowupWindow(monday18) === false);
  // תוספת (לא התבקשה במפורש, אבל נובעת מ"יום העבודה" ומ-isWorkday הקיים במערכת) — יום שישי חסום.
  check("10:00 שישי (יום לא-עבודה) → לא רץ", isWithinFollowupWindow(friday10) === false);
  check("FOLLOWUP_SCHEDULE_CONFIG: 15 דק', 08:30–17:30, לא מספרים מפוזרים", FOLLOWUP_SCHEDULE_CONFIG.intervalMinutes === 15 && FOLLOWUP_SCHEDULE_CONFIG.workdayStart.hour === 8 && FOLLOWUP_SCHEDULE_CONFIG.workdayStart.minute === 30 && FOLLOWUP_SCHEDULE_CONFIG.workdayEnd.hour === 17 && FOLLOWUP_SCHEDULE_CONFIG.workdayEnd.minute === 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. timezone הוא Asia/Jerusalem, לא timezone של השרת
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── timezone: Asia/Jerusalem, לא local machine ──");
{
  // אותו רגע פיזי בדיוק כמו monday10 (10:00 ישראל) — אבל מיוצג כ-DateTime ב-UTC. אם isWithinFollowupWindow
  // היה מסתמך על אזור הזמן של המחרוזת/המכונה במקום להמיר במפורש ל-env.TIMEZONE — זה היה נכשל כאן.
  const sameInstantAsUtc = monday10.toUTC();
  check("אותו רגע, מיוצג כ-UTC → עדיין מזוהה כ-'בתוך החלון' (10:00 ישראל)", isWithinFollowupWindow(sameInstantAsUtc) === true);
  // ובכיוון ההפוך: 20:00 "לפי איזור זמן אחר לגמרי" (ניו-יורק, UTC-4 בספטמבר) = 03:00 לפנות בוקר בישראל
  // (היום הבא) — רגע מחוץ לחלון לגמרי. אם הפונקציה הייתה מתעלמת מהאזור ומתייחסת ל-"20" כאילו הוא כבר
  // שעון ישראל, זה היה (בטעות) נכשל כ"מחוץ לחלון" מסיבה לא-נכונה של "אחרי 17:30" ולא בגלל שהיא לא ממירה בכלל.
  // לכן הבדיקה האמיתית: שהתוצאה תלויה ב-instant (UTC) ולא בשעה הגולמית שנכתבה במחרוזת הקלט.
  const eightPmNewYork = DateTime.fromObject({ year: 2026, month: 9, day: 14, hour: 20, minute: 0 }, { zone: "America/New_York" });
  check(
    "20:00 ניו-יורק = 03:00 לפנות בוקר בישראל → מחוץ לחלון (הפונקציה ממירה לפי env.TIMEZONE, לא לפי מחרוזת הקלט)",
    isWithinFollowupWindow(eightPmNewYork) === false,
    `israelTime=${eightPmNewYork.setZone(env.TIMEZONE).toFormat("HH:mm")}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4-5. startup catch-up
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 4-5. startup catch-up ──");
{
  const itemId = "__sched_startup_inwindow__";
  const f = makeDueFollowup(itemId, "2026-09-10");
  db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(monday10.minus({ hours: 1 }).toUTC().toISO(), f.id);

  let notified = 0;
  const ran = await maybeRunFollowupCatchUpOnStartup(monday11, { ...okDeps("בעבודה"), addNotification: () => { notified++; return 1; } });
  check("startup ב-11:00 (בתוך חלון) → מחזיר true (רץ catch-up)", ran === true);
  check("startup ב-11:00 → ה-follow-up שהגיע זמנו טופל מיד (לא מחכה 15 דק')", getFollowup(f.id)!.status === "triggered" && notified === 1);
}
{
  const itemId = "__sched_startup_night__";
  const f = makeDueFollowup(itemId, "2026-09-10");
  db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(monday10.minus({ hours: 1 }).toUTC().toISO(), f.id);

  let notified = 0;
  const ran = await maybeRunFollowupCatchUpOnStartup(monday22, { ...okDeps("בעבודה"), addNotification: () => { notified++; return 1; } });
  check("startup ב-22:00 (מחוץ לחלון) → מחזיר false (לא רץ)", ran === false);
  check("startup בלילה → אין שום פנייה לעובד, ה-follow-up נשאר pending וממתין לבוקר", getFollowup(f.id)!.status === "pending" && notified === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. overdue מאתמול נתפס בסבב הראשון בבוקר — runDueFollowups לא מסונן לפי חלון, רק dueAt<=now
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 6. follow-up ישן (מאתמול/מלילה) נתפס בסבב הבוקר ──");
{
  const itemId = "__sched_overdue_from_yesterday__";
  const f = makeDueFollowup(itemId, "2026-09-10");
  // due_at מ"אתמול בערב" — הרבה לפני שהחלון של הבוקר נפתח.
  db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(monday10.minus({ days: 1, hours: 3 }).toUTC().toISO(), f.id);

  const result = await runFollowupCycle(monday10, okDeps("בעבודה"));
  check("סבב הבוקר (10:00, בתוך החלון) מוצא ומטפל בפריט הישן", !!result && result.processed.some((p) => p.id === f.id && p.outcome === "nudge_sent"));
  check("סטטוס סופי triggered", getFollowup(f.id)!.status === "triggered");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. מניעת overlap — שני runFollowupCycle "בו-זמנית", השני מדלג
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 7. מניעת overlap ──");
{
  const itemId = "__sched_overlap__";
  const f = makeDueFollowup(itemId, "2026-09-10");
  db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(monday10.minus({ hours: 1 }).toUTC().toISO(), f.id);

  let getStatusCalls = 0;
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const slowDeps: FollowupRunnerDeps = {
    getTaskStatusLabel: async () => {
      getStatusCalls++;
      await gate;
      return "בעבודה";
    },
    addNotification: () => 1,
    publishNudge: () => {},
  };

  const p1 = runFollowupCycle(monday10, slowDeps);
  const p2 = runFollowupCycle(monday10, slowDeps); // נקרא בזמן שה-guard כבר דלוק (סינכרוני, לפני ה-await הראשון של p1)
  const r2 = await p2;
  check("הסבב השני (בזמן שהראשון עדיין רץ) חוזר null מיד — לא מתחיל לעבד", r2 === null);

  releaseGate!();
  const r1 = await p1;
  check("הסבב הראשון בכל זאת מסיים בהצלחה", !!r1 && r1.processed.some((p) => p.id === f.id && p.outcome === "nudge_sent"));
  check("getTaskStatusLabel נקרא פעם אחת בדיוק — אין עיבוד כפול של אותו followup", getStatusCalls === 1, String(getStatusCalls));
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. בידוד כשל: item אחד נכשל לא מונע טיפול בבא אחריו
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 8. בידוד כשל בין items ──");
{
  const failingItemId = "__sched_isolation_fail__";
  const okItemId = "__sched_isolation_ok__";
  const fFail = makeDueFollowup(failingItemId, "2026-09-10");
  const fOk = makeDueFollowup(okItemId, "2026-09-10");
  db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(monday10.minus({ hours: 1 }).toUTC().toISO(), fFail.id);
  db.prepare(`UPDATE control_followups SET due_at = ? WHERE id = ?`).run(monday10.minus({ hours: 1 }).toUTC().toISO(), fOk.id);

  const deps: FollowupRunnerDeps = {
    getTaskStatusLabel: async (source, itemId) => {
      if (itemId === failingItemId) throw new Error("Monday API נכשל (מדומה) — item בודד");
      return "בעבודה";
    },
    addNotification: () => 1,
    publishNudge: () => {},
  };

  const result = await runFollowupCycle(monday10, deps);
  check("הסבב מטפל בשני הפריטים (לא עוצר בכשל הראשון)", !!result && result.checked === 2);
  check("הפריט שנכשל חזר ל-pending עם שגיאה (לא נעלם, לא תקוע)", getFollowup(fFail.id)!.status === "pending" && !!getFollowup(fFail.id)!.lastError);
  check("הפריט התקין בכל זאת עובד בהצלחה למרות שהאחר נכשל", getFollowup(fOk.id)!.status === "triggered");
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. shutdown מנקה את ה-timer — לא משאירים setInterval יתום
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── 9. start/stop לא משאיר timer יתום ──");
{
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const createdHandles: unknown[] = [];
  const clearedHandles: unknown[] = [];
  // @ts-expect-error — מונקי-פאץ' זמני לצורך הבדיקה בלבד, משוחזר מיד אחריה.
  globalThis.setInterval = (fn: () => void, ms: number) => {
    const h = realSetInterval(fn, ms);
    createdHandles.push(h);
    return h;
  };
  globalThis.clearInterval = (h: unknown) => {
    clearedHandles.push(h);
    return realClearInterval(h as Parameters<typeof clearInterval>[0]);
  };

  try {
    startFollowupSchedule();
    check("start יוצר interval אחד", createdHandles.length === 1);
    startFollowupSchedule(); // אמור להיות idempotent — לא ליצור עוד אחד
    check("start חוזר לא יוצר interval כפול (idempotent)", createdHandles.length === 1);
    stopFollowupSchedule();
    check("stop קורא ל-clearInterval עם אותו handle שנוצר", clearedHandles.length === 1 && clearedHandles[0] === createdHandles[0]);
    stopFollowupSchedule(); // stop כפול לא אמור לזרוק
    check("stop כפול לא זורק ולא מנסה לנקות שוב", clearedHandles.length === 1);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
}

cleanup();

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות חיבור ה-scheduler ל-Follow-up Engine עברו ✅");
