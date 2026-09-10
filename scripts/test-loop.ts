/**
 * בדיקות הלולאה (Phases 2–4): finding_events, החלטת ההסלמה, נוסח הפנייה, מיפוי תוויות.
 * לוגיקה טהורה — בלי Monday. הבדיקה החיה מקצה-לקצה נעשית בשרת (Phase 5).
 *
 *   npm run test:loop
 */

import "dotenv/config";
import { DateTime } from "luxon";
import { db } from "../src/db/db.js";
import {
  isResolvedByReply,
  lastResponseAt,
  recordFindingEvent,
  snoozedUntil,
} from "../src/db/repositories/findingEvents.js";
import { buildNudgeText, escalationDecision } from "../src/ops/escalation.js";
import { PARKED_LABEL, waitingLabel } from "../src/integrations/monday/opsWrite.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean) => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}`);
    failed++;
  }
};

const now = DateTime.fromISO("2026-09-10T12:00:00", { zone: "Asia/Jerusalem" }); // יום ה'
const K = "__test_loop__";
db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '${K}%'`);

// ---- finding_events repo ----
recordFindingEvent(`${K}a`, "nudge_sent", { byUser: "dov" });
recordFindingEvent(`${K}a`, "employee_responded", { byUser: "dov", note: "עוד קצת" });
check("lastResponseAt מחזיר את התגובה", lastResponseAt(`${K}a`) !== null);
check("אין snooze על a", snoozedUntil(`${K}a`) === null);
check("a לא נסגר", isResolvedByReply(`${K}a`) === false);

recordFindingEvent(`${K}b`, "snoozed", { snoozeUntil: "2026-09-15" });
check("snoozedUntil מחזיר את התאריך", snoozedUntil(`${K}b`) === "2026-09-15");

recordFindingEvent(`${K}c`, "resolved_by_reply", { action: "done" });
check("c נסגר בעקבות תשובה", isResolvedByReply(`${K}c`) === true);

// ---- escalationDecision ----
const base = { escalationLevel: 0, severity: "high" as const };
const fresh4d = { ...base, findingKey: `${K}fresh`, firstSeen: "2026-09-04T09:00:00+03:00" }; // 4 ימי עבודה קודם
const deps0 = { isResolvedByReply: () => false, snoozedUntil: () => null, lastResponseAt: () => null };

const d1 = escalationDecision(fresh4d, now, deps0);
check("ממצא ישן (כמה ימי עבודה) → target 3", !d1.skip && d1.target === 3 && d1.stale >= 3);

// ממצא בן יום עבודה אחד → target 1 (תזכורת לעובד בלבד)
const d1b = escalationDecision(
  { ...base, findingKey: `${K}day1`, firstSeen: now.minus({ days: 1 }).toISO()! },
  now,
  deps0,
);
check("ממצא בן יום עבודה 1 → target 1", !d1b.skip && d1b.target === 1);

const d2 = escalationDecision(
  { ...base, findingKey: `${K}x`, firstSeen: "2026-09-04T09:00:00+03:00" },
  now,
  { ...deps0, isResolvedByReply: () => true },
);
check("resolved_by_reply → skip", d2.skip && d2.skipReason === "resolved_by_reply");

const d3 = escalationDecision(fresh4d, now, { ...deps0, snoozedUntil: () => "2026-09-15" });
check("snoozed לעתיד → skip", d3.skip && d3.skipReason === "snoozed");

const d4 = escalationDecision(fresh4d, now, { ...deps0, snoozedUntil: () => "2026-09-08" });
check("snoozed שעבר → לא skip", !d4.skip);

const d5 = escalationDecision(fresh4d, now, { ...deps0, lastResponseAt: () => "2026-09-10T08:00:00+03:00" });
check("תגובה היום → שעון מתאפס, target 0", !d5.skip && d5.stale === 0 && d5.target === 0);

const d6 = escalationDecision(
  { ...base, findingKey: `${K}crit`, firstSeen: "2026-09-10T08:00:00+03:00", severity: "critical" },
  now,
  deps0,
);
check("critical → target 3 מייד", !d6.skip && d6.target === 3);

// ---- buildNudgeText ----
const txt = buildNudgeText(
  { who: "דוב שפירא", headline: "באיחור 3 ימים: תוכנית חשמל", kind: "overdue_stale", project: "כהן" },
  "3 ימי עבודה בלי תזוזה",
);
check("נוסח הפנייה כולל שם פרטי", txt.startsWith("דוב,"));
check("נוסח הפנייה כולל שם המשימה", txt.includes("תוכנית חשמל"));
check("נוסח הפנייה כולל את הפרויקט", txt.includes("כהן"));
check("נוסח הפנייה שואל מה המצב", txt.includes("מה המצב?"));

// ---- מיפוי תוויות ----
check("waiting client / project → 'ממתין ללקוח'", waitingLabel("project_stage", "client") === "ממתין ללקוח");
check("waiting consultant / project → 'מתתין ליועץ/ספק/אחר'", waitingLabel("project_stage", "consultant") === "מתתין ליועץ/ספק/אחר");
check("waiting client / general → 'ממתין להתייחסות'", waitingLabel("general", "client") === "ממתין להתייחסות");
check("parked general → 'מושהה'", PARKED_LABEL.general === "מושהה");
check("parked project → 'לא רלוונטי'", PARKED_LABEL.project_stage === "לא רלוונטי");

db.exec(`DELETE FROM finding_events WHERE finding_key LIKE '${K}%'`);

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות הלולאה עברו ✅");
