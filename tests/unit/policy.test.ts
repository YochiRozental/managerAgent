/**
 * Policy Engine (src/ops/policy.ts) — העברה אחד-לאחד של scripts/test-policy.ts ל-Vitest.
 * אותם 24 בדיקות, אותם קלטים, אותם תנאים. הסקריפט הישן הוסר.
 * לוגיקה טהורה — בלי Monday, בלי AI, בלי DB.
 */

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  countDeferrals,
  evaluateCancellationRequest,
  evaluateCompletionRequest,
  evaluateDeferralRequest,
  evaluateReassignmentRequest,
  POLICY_CONFIG,
  type ApprovalContext,
  type DeferralRecord,
} from "../../src/ops/policy.js";

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

describe("דחיות אחרי איחור", () => {
  it("1. דחייה של יומיים אחרי איחור → מותר", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(2), history: noHistory, reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("allow");
    expect(d.ruleId).toBe("after-overdue-short");
  });

  it("2. דחייה של 5 ימים עם הסבר הגיוני → מותר", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(5), history: noHistory, reasonJudgedPlausible: true,
    });
    expect(d.action).toBe("allow");
    expect(d.ruleId).toBe("after-overdue-reason-plausible");
  });

  it("3. דחייה של 5 ימים בלי הסבר → צריך בירור", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(5), history: noHistory, reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("needs_clarification");
    expect(d.question).toBeTruthy();
  });

  it("[בונוס] 5 ימים עם סיבה לא-משכנעת → אישור מוטי", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(5), history: noHistory, reasonJudgedPlausible: false,
    });
    expect(d.action).toBe("manager_approval_required");
  });

  it("4. דחייה של 10 ימים → אישור מוטי (תקרה מוחלטת, גם עם סיבה הגיונית)", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(10), history: noHistory, reasonJudgedPlausible: true,
    });
    expect(d.action).toBe("manager_approval_required");
    expect(d.ruleId).toBe("after-overdue-long");
    expect(d.approvalPayload).toBeTruthy();
  });

  it("5. פספוס התחייבות חדשה → אישור מוטי", () => {
    const priorDeferral: DeferralRecord = { requestedAt: now.minus({ days: 1 }).toISO()!, wasOverdue: true, newDueDate: iso(-1) };
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(1), history: [priorDeferral], reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("manager_approval_required");
    expect(d.ruleId).toBe("after-overdue-commitment-missed");
  });
});

describe("דחיות מראש (לפני איחור)", () => {
  it("6. דחייה מראש ראשונה → מותר", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: futureDue, requestedNewDueDate: iso(15), history: noHistory, reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("allow");
    expect(d.ruleId).toBe("before-due-ok");
  });

  it("7. דחייה מראש שנייה → מותר", () => {
    const oneBefore: DeferralRecord[] = [{ requestedAt: now.minus({ days: 1 }).toISO()!, wasOverdue: false, newDueDate: futureDue }];
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: futureDue, requestedNewDueDate: iso(20), history: oneBefore, reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("allow");
    expect(d.ruleId).toBe("before-due-ok");
  });

  it("8. דחייה מראש שלישית → אישור מוטי", () => {
    const twoBefore: DeferralRecord[] = [
      { requestedAt: now.minus({ days: 2 }).toISO()!, wasOverdue: false, newDueDate: futureDue },
      { requestedAt: now.minus({ days: 1 }).toISO()!, wasOverdue: false, newDueDate: futureDue },
    ];
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: futureDue, requestedNewDueDate: iso(25), history: twoBefore, reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("manager_approval_required");
    expect(d.ruleId).toBe("before-due-too-many");
    expect(d.approvalPayload).toBeTruthy();
  });
});

describe("סיום / ביטול / שיוך", () => {
  it("9. 'בוצע' → מותר לסגור", () => {
    expect(evaluateCompletionRequest().action).toBe("allow");
  });

  it("10. 'לא רלוונטי' → אישור מוטי", () => {
    const d = evaluateCancellationRequest(ctx, "הלקוח ביטל את הפרויקט");
    expect(d.action).toBe("manager_approval_required");
    expect(d.approvalPayload?.kind).toBe("cancellation");
  });

  it("[בונוס] approvalPayload נושא את itemId/findingKey/requestedBy", () => {
    const d = evaluateCancellationRequest(ctx, "הלקוח ביטל את הפרויקט");
    expect(d.approvalPayload?.itemId).toBe(ctx.itemId);
    expect(d.approvalPayload?.findingKey).toBe(ctx.findingKey);
    expect(d.approvalPayload?.requestedBy).toBe(ctx.requestedBy);
  });

  it("11. 'זו משימה של איתן' → אישור מוטי", () => {
    const d = evaluateReassignmentRequest(ctx, "איתן ברמן");
    expect(d.action).toBe("manager_approval_required");
    expect(d.approvalPayload?.kind).toBe("reassignment");
    expect(d.approvalPayload?.details.claimedOwner).toBe("איתן ברמן");
  });
});

describe("עזרים", () => {
  it("countDeferrals מפצל נכון לפני/אחרי איחור", () => {
    const mixed: DeferralRecord[] = [
      { requestedAt: "a", wasOverdue: false, newDueDate: "2026-09-01" },
      { requestedAt: "b", wasOverdue: false, newDueDate: "2026-09-02" },
      { requestedAt: "c", wasOverdue: true, newDueDate: "2026-09-05" },
    ];
    expect(countDeferrals(mixed)).toMatchObject({ beforeOverdue: 2, afterOverdue: 1 });
  });

  it("POLICY_CONFIG.afterOverdue.autoApproveWithinDays = 3", () => {
    expect(POLICY_CONFIG.afterOverdue.autoApproveWithinDays).toBe(3);
  });
  it("POLICY_CONFIG.afterOverdue.withReasonUpToDays = 7", () => {
    expect(POLICY_CONFIG.afterOverdue.withReasonUpToDays).toBe(7);
  });
  it("POLICY_CONFIG.beforeDue.autoApproveCount = 2", () => {
    expect(POLICY_CONFIG.beforeDue.autoApproveCount).toBe(2);
  });
});

describe("missedCommitment (Rule 4, EOD Engine)", () => {
  // dueDate=היום + missedCommitment=true → אישור מוטי, גם ש-date-only math לא רואה overdue.
  const todayDue = now.toISODate()!;
  const missedToday = () =>
    evaluateDeferralRequest({
      ctx, now, currentDueDate: todayDue, requestedNewDueDate: iso(1), history: noHistory, reasonJudgedPlausible: null,
      missedCommitment: true,
    });

  it("dueDate=היום + missedCommitment=true → manager_approval_required (eod-commitment-missed)", () => {
    const d = missedToday();
    expect(d.action).toBe("manager_approval_required");
    expect(d.ruleId).toBe("eod-commitment-missed");
  });
  it("wasOverdue עצמו נשאר false (date-only math לא זויף)", () => {
    expect(missedToday().wasOverdue).toBe(false);
  });
  it("ה-approvalPayload.details מסמן missedCommitment=true במפורש (context, לא ניחוש)", () => {
    expect(missedToday().approvalPayload?.details.missedCommitment).toBe(true);
  });

  it("proactive deferral לפני due date, בלי missedCommitment → before-due-ok, לא נגרר ל-missed commitment", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: iso(5), requestedNewDueDate: iso(8), history: noHistory, reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("allow");
    expect(d.ruleId).toBe("before-due-ok");
  });

  it("dueDate=היום + missedCommitment=false → מתנהג כמו לפני (before-due), לא נדרש מוטי סתם", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: todayDue, requestedNewDueDate: iso(1), history: noHistory, reasonJudgedPlausible: null,
      missedCommitment: false,
    });
    expect(d.action).toBe("allow");
    expect(d.ruleId).toBe("before-due-ok");
  });

  it("[רגרסיה] dueDate overdue, בלי missedCommitment → after-overdue-short כרגיל", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(2), history: noHistory, reasonJudgedPlausible: null,
    });
    expect(d.action).toBe("allow");
    expect(d.ruleId).toBe("after-overdue-short");
    expect(d.wasOverdue).toBe(true);
  });

  it("[רגרסיה] dueDate overdue + missedCommitment=true → עדיין manager_approval_required (eod-commitment-missed)", () => {
    const d = evaluateDeferralRequest({
      ctx, now, currentDueDate: overdueDue, requestedNewDueDate: iso(1), history: noHistory, reasonJudgedPlausible: null,
      missedCommitment: true,
    });
    expect(d.action).toBe("manager_approval_required");
    expect(d.ruleId).toBe("eod-commitment-missed");
  });
});
