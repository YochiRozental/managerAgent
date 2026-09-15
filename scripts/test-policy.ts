/**
 * בדיקות ל-Policy Engine (src/ops/policy.ts) — כל 11 התרחישים שהתבקשו + כמה בונוס.
 * לוגיקה טהורה לגמרי — בלי Monday, בלי AI, בלי DB (history מוזרק ישירות).
 *
 *   npm run test:policy
 */

import { DateTime } from "luxon";
import {
  countDeferrals,
  evaluateCancellationRequest,
  evaluateCompletionRequest,
  evaluateDeferralRequest,
  evaluateReassignmentRequest,
  POLICY_CONFIG,
  type ApprovalContext,
  type DeferralRecord,
} from "../src/ops/policy.js";
import { logger } from "../src/utils/logger.js";

let failed = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) logger.info(`✅ ${label}`);
  else {
    logger.error(`❌ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
};

const now = DateTime.fromISO("2026-09-14T10:00:00", { zone: "Asia/Jerusalem" }); // "היום" לכל הבדיקות
const ctx: ApprovalContext = {
  itemId: "999",
  source: "general",
  findingKey: "overdue:999",
  taskName: "בדיקת מדיניות",
  requestedBy: "dov",
};
const overdueDue = now.minus({ days: 2 }).toISODate()!; // תאריך יעד שכבר עבר
const futureDue = now.plus({ days: 10 }).toISODate()!; // תאריך יעד עתידי — עדיין לא באיחור
const noHistory: DeferralRecord[] = [];

function iso(daysFromNow: number): string {
  return now.plus({ days: daysFromNow }).toISODate()!;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11 התרחישים שהתבקשו
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── דחיות אחרי איחור ──");

{
  // 1. דחייה של יומיים אחרי איחור → מותר
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(2),
    history: noHistory,
    reasonJudgedPlausible: null,
  });
  check("דחייה של יומיים אחרי איחור → מותר", d.action === "allow" && d.ruleId === "after-overdue-short", d.action);
}

{
  // 2. דחייה של 5 ימים עם הסבר הגיוני → מותר
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(5),
    history: noHistory,
    reasonJudgedPlausible: true,
  });
  check("דחייה של 5 ימים עם הסבר הגיוני → מותר", d.action === "allow" && d.ruleId === "after-overdue-reason-plausible", d.action);
}

{
  // 3. דחייה של 5 ימים בלי הסבר → צריך בירור
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(5),
    history: noHistory,
    reasonJudgedPlausible: null,
  });
  check(
    "דחייה של 5 ימים בלי הסבר → צריך בירור",
    d.action === "needs_clarification" && !!d.question,
    d.action,
  );
}

{
  // 3ב (בונוס): 5 ימים עם סיבה שנשמעה לא משכנעת → אישור מוטי (לא allow, לא needs_clarification)
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(5),
    history: noHistory,
    reasonJudgedPlausible: false,
  });
  check("[בונוס] 5 ימים עם סיבה לא-משכנעת → אישור מוטי", d.action === "manager_approval_required", d.action);
}

{
  // 4. דחייה של 10 ימים → אישור מוטי (תקרה מוחלטת, גם עם סיבה הגיונית)
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(10),
    history: noHistory,
    reasonJudgedPlausible: true,
  });
  check(
    "דחייה של 10 ימים → אישור מוטי",
    d.action === "manager_approval_required" && d.ruleId === "after-overdue-long" && !!d.approvalPayload,
    d.action,
  );
}

{
  // 5. פספוס התחייבות חדשה → אישור מוטי (כבר נוצלה דחייה אחת אחרי איחור, ולא עמדו בה)
  const priorDeferral: DeferralRecord = { requestedAt: now.minus({ days: 1 }).toISO()!, wasOverdue: true, newDueDate: iso(-1) };
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(1), // אפילו בקשה קטנה מאוד
    history: [priorDeferral],
    reasonJudgedPlausible: null,
  });
  check(
    "פספוס התחייבות חדשה → אישור מוטי",
    d.action === "manager_approval_required" && d.ruleId === "after-overdue-commitment-missed",
    d.action,
  );
}

logger.info("── דחיות מראש (לפני איחור) ──");

{
  // 6. דחייה מראש ראשונה → מותר
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: futureDue,
    requestedNewDueDate: iso(15),
    history: noHistory,
    reasonJudgedPlausible: null,
  });
  check("דחייה מראש ראשונה → מותר", d.action === "allow" && d.ruleId === "before-due-ok", d.action);
}

{
  // 7. דחייה מראש שנייה → מותר
  const oneBefore: DeferralRecord[] = [{ requestedAt: now.minus({ days: 1 }).toISO()!, wasOverdue: false, newDueDate: futureDue }];
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: futureDue,
    requestedNewDueDate: iso(20),
    history: oneBefore,
    reasonJudgedPlausible: null,
  });
  check("דחייה מראש שנייה → מותר", d.action === "allow" && d.ruleId === "before-due-ok", d.action);
}

{
  // 8. דחייה מראש שלישית → אישור מוטי
  const twoBefore: DeferralRecord[] = [
    { requestedAt: now.minus({ days: 2 }).toISO()!, wasOverdue: false, newDueDate: futureDue },
    { requestedAt: now.minus({ days: 1 }).toISO()!, wasOverdue: false, newDueDate: futureDue },
  ];
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: futureDue,
    requestedNewDueDate: iso(25),
    history: twoBefore,
    reasonJudgedPlausible: null,
  });
  check(
    "דחייה מראש שלישית → אישור מוטי",
    d.action === "manager_approval_required" && d.ruleId === "before-due-too-many" && !!d.approvalPayload,
    d.action,
  );
}

logger.info("── סיום / ביטול / שיוך ──");

{
  // 9. "בוצע" → מותר לסגור
  const d = evaluateCompletionRequest();
  check("'בוצע' → מותר לסגור", d.action === "allow");
}

{
  // 10. "לא רלוונטי" → אישור מוטי
  const d = evaluateCancellationRequest(ctx, "הלקוח ביטל את הפרויקט");
  check(
    "'לא רלוונטי' → אישור מוטי",
    d.action === "manager_approval_required" && d.approvalPayload?.kind === "cancellation",
    d.action,
  );
  check("[בונוס] approvalPayload נושא את itemId/findingKey/requestedBy", d.approvalPayload?.itemId === ctx.itemId && d.approvalPayload?.findingKey === ctx.findingKey && d.approvalPayload?.requestedBy === ctx.requestedBy);
}

{
  // 11. "זו משימה של איתן" → אישור מוטי
  const d = evaluateReassignmentRequest(ctx, "איתן ברמן");
  check(
    "'זו משימה של איתן' → אישור מוטי",
    d.action === "manager_approval_required" && d.approvalPayload?.kind === "reassignment" && d.approvalPayload?.details.claimedOwner === "איתן ברמן",
    d.action,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// בונוס: countDeferrals + config
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── עזרים ──");

{
  const mixed: DeferralRecord[] = [
    { requestedAt: "a", wasOverdue: false, newDueDate: "2026-09-01" },
    { requestedAt: "b", wasOverdue: false, newDueDate: "2026-09-02" },
    { requestedAt: "c", wasOverdue: true, newDueDate: "2026-09-05" },
  ];
  const counts = countDeferrals(mixed);
  check("countDeferrals מפצל נכון לפני/אחרי איחור", counts.beforeOverdue === 2 && counts.afterOverdue === 1, JSON.stringify(counts));
}

check("POLICY_CONFIG.afterOverdue.autoApproveWithinDays = 3", POLICY_CONFIG.afterOverdue.autoApproveWithinDays === 3);
check("POLICY_CONFIG.afterOverdue.withReasonUpToDays = 7", POLICY_CONFIG.afterOverdue.withReasonUpToDays === 7);
check("POLICY_CONFIG.beforeDue.autoApproveCount = 2", POLICY_CONFIG.beforeDue.autoApproveCount === 2);

// ─────────────────────────────────────────────────────────────────────────────
// Rule 4 — missedCommitment: context מפורש, נפרד מ-wasOverdue (audit 2026-09-16)
// ─────────────────────────────────────────────────────────────────────────────

logger.info("── missedCommitment (Rule 4, EOD Engine) ──");

{
  // dueDate=היום + missedCommitment=true → אישור מוטי, גם ש-date-only math לא רואה overdue.
  const todayDue = now.toISODate()!;
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: todayDue,
    requestedNewDueDate: iso(1),
    history: noHistory,
    reasonJudgedPlausible: null,
    missedCommitment: true,
  });
  check(
    "dueDate=היום + missedCommitment=true → manager_approval_required (eod-commitment-missed)",
    d.action === "manager_approval_required" && d.ruleId === "eod-commitment-missed",
    d.action,
  );
  check("wasOverdue עצמו נשאר false (date-only math לא זויף)", d.wasOverdue === false);
  check(
    "ה-approvalPayload.details מסמן missedCommitment=true במפורש (context, לא ניחוש)",
    d.approvalPayload?.details.missedCommitment === true,
  );
}

{
  // proactive deferral רגילה לפני due date, בלי missedCommitment → מתנהג בדיוק כמו קודם (before-due).
  const futureDue2 = iso(5);
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: futureDue2,
    requestedNewDueDate: iso(8),
    history: noHistory,
    reasonJudgedPlausible: null,
    // missedCommitment לא מועבר בכלל (undefined) — כמו כל קריאה קיימת לפני השלב הזה.
  });
  check(
    "proactive deferral לפני due date, בלי missedCommitment → before-due-ok, לא נגרר ל-missed commitment",
    d.action === "allow" && d.ruleId === "before-due-ok",
    d.action,
  );
}

{
  // dueDate=היום, אבל missedCommitment לא הועבר (false/undefined) → לא נדרש אישור מוטי סתם כי יש
  // איזשהו follow-up — ההתנהגות הרגילה (before-due, כי date-only math רואה dueDate=היום כלא-overdue).
  const todayDue = now.toISODate()!;
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: todayDue,
    requestedNewDueDate: iso(1),
    history: noHistory,
    reasonJudgedPlausible: null,
    missedCommitment: false,
  });
  check(
    "dueDate=היום + missedCommitment=false → מתנהג כמו לפני (before-due), לא נדרש מוטי סתם",
    d.action === "allow" && d.ruleId === "before-due-ok",
    d.action,
  );
}

{
  // רגרסיה: dueDate overdue, בלי missedCommitment → ההתנהגות הקיימת (after-overdue-short) נשמרת.
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(2),
    history: noHistory,
    reasonJudgedPlausible: null,
  });
  check(
    "[רגרסיה] dueDate overdue, בלי missedCommitment → after-overdue-short כרגיל",
    d.action === "allow" && d.ruleId === "after-overdue-short" && d.wasOverdue === true,
    d.action,
  );
}

{
  // רגרסיה: dueDate overdue + missedCommitment=true → גם ככה manager_approval_required (לא סותר
  // את הכלל הרגיל — רק ruleId שונה, כי זה context מפורש יותר).
  const d = evaluateDeferralRequest({
    ctx,
    now,
    currentDueDate: overdueDue,
    requestedNewDueDate: iso(1),
    history: noHistory,
    reasonJudgedPlausible: null,
    missedCommitment: true,
  });
  check(
    "[רגרסיה] dueDate overdue + missedCommitment=true → עדיין manager_approval_required (eod-commitment-missed)",
    d.action === "manager_approval_required" && d.ruleId === "eod-commitment-missed",
    d.action,
  );
}

if (failed) {
  logger.error(`\n${failed} בדיקות נכשלו`);
  process.exit(1);
}
logger.info("\nכל בדיקות ה-Policy Engine עברו ✅");
