/**
 * תצורת Vitest — `npm test` מריץ **רק** את הבדיקות ברשימה SAFE_TESTS.
 *
 * כל קובץ כאן אושר במפורש כבטוח: בלי Monday אמיתי, בלי AI בתשלום, בלי WhatsApp/מייל, ועם DB זמני
 * מבודד (tests/setup/). בדיקה חדשה נכנסת לרשימה רק אחרי בדיקה ואישור — לא אוטומטית לפי תיקייה.
 * tests/live ו-tests/e2e לעולם לא רצים מכאן — ראה tests/README.md.
 */

import { defineConfig } from "vitest/config";

const SAFE_TESTS = [
  // תשתית — חייבות לעבור לפני כל השאר
  "tests/unit/dbIsolation.test.ts",
  "tests/unit/isolation.test.ts",
  // unit — לוגיקה טהורה
  "tests/unit/policy.test.ts",
  "tests/unit/identity.test.ts",
  "tests/unit/modelRouter.test.ts",
  "tests/unit/myWorkBrief.test.ts",
  "tests/unit/officeStateSingleFlight.test.ts",
  "tests/unit/reverseDependencyMapSingleFlight.test.ts",
  "tests/unit/officeOverviewPerfReliability.test.ts",
  "tests/unit/userTasksFetchDiagnostics.test.ts",
  "tests/unit/stageStatusServerFilter.test.ts",
  "tests/unit/aiProviders.test.ts",
  "tests/unit/attendanceEngine.test.ts",
  "tests/unit/employeeFeed.test.ts",
  "tests/unit/sharedPrompt.test.ts",
  "tests/unit/toolRegistry.test.ts",
  "tests/unit/sharedToolRegistry.test.ts",
  "tests/unit/sharedDispatcher.test.ts",
  "tests/unit/toolParity.test.ts",
  "tests/unit/createTaskPrompt.test.ts",
  "tests/unit/projectScope.test.ts",
  "tests/unit/libsignalLogPatch.test.ts",
  "tests/unit/whatsappSelfchatDiscriminator.test.ts",
  "tests/unit/agentTools.test.ts",
  "tests/unit/webSharedToolDefinition.test.ts",
  "tests/unit/whatsappAgentTools.test.ts",
  "tests/unit/sourceCalls.test.ts",
  "tests/unit/agentLoopPerf.test.ts",
  "tests/unit/routedAgentPerf.test.ts",
  "tests/unit/chatPerfMetrics.test.ts",
  "tests/unit/chatPerfSteps.test.ts",
  "tests/unit/promptCacheSplit.test.ts",
  "tests/unit/personProjectBreakdown.test.ts",
  "tests/unit/notificationsHistory.test.ts",
  "tests/unit/attendanceReminderText.test.ts",
  "tests/unit/mondayItemUrl.test.ts",
  "tests/unit/uiHtmlScriptSyntax.test.ts",
  "tests/unit/promptAboutBranches.test.ts",
  "tests/unit/relativeDates.test.ts",
  "tests/unit/bulkQuery.test.ts",
  "tests/unit/setItemStatus.test.ts",
  // integration — DB זמני מבודד בלבד
  "tests/integration/loop.test.ts",
  "tests/integration/approvals.test.ts",
  "tests/integration/approvalsAudit.test.ts",
  "tests/integration/approvalConversation.test.ts",
  "tests/integration/cancellationApproval.test.ts",
  "tests/integration/attendance.test.ts",
  "tests/integration/attendanceConcurrency.test.ts",
  "tests/integration/attendanceTools.test.ts",
  "tests/integration/attendanceMondaySync.test.ts",
  "tests/integration/attendanceIncident1013.test.ts",
  "tests/integration/deferralPlan.test.ts",
  "tests/integration/followups.test.ts",
  "tests/integration/followupScheduler.test.ts",
  "tests/integration/initialOverdueNudge.test.ts",
  "tests/integration/escalationContext.test.ts",
  "tests/integration/findingIdentityHealing.test.ts",
  "tests/integration/visibleForReports.test.ts",
  "tests/integration/eodEngine.test.ts",
  "tests/integration/eodSummary.test.ts",
  "tests/integration/replyDefer.test.ts",
  "tests/integration/projectStage.test.ts",
  "tests/integration/taskCreation.test.ts",
  "tests/integration/chatDedup.test.ts",
  "tests/integration/health.test.ts",
  "tests/integration/backfillEscalationIdentity.test.ts",
  "tests/integration/whatsappLifecycle.test.ts",
  "tests/integration/whatsappInstrumentation.test.ts",
  "tests/integration/whatsappReplyLoop.test.ts",
  "tests/integration/leadContact.test.ts",
  "tests/integration/attendancePilotReadiness.test.ts",
  "tests/integration/chatPerfMetrics.test.ts",
  "tests/integration/chatPerfSteps.test.ts",
  "tests/integration/lazyTasksLoading.test.ts",
  "tests/integration/promptCachingExperiment.test.ts",
  "tests/integration/commitmentLoop.test.ts",
  "tests/integration/notificationReadVsHandled.test.ts",
  "tests/integration/attendanceReminderWorkDate.test.ts",
  "tests/integration/attendanceReminderLifecycle.test.ts",
  "tests/integration/bulkUpdate.test.ts",
  "tests/integration/bulkChat.test.ts",
  "tests/integration/dateRouting.test.ts",
  // regression — הוכחה שהתנהגות קיימת לא השתנתה (מודל מוזרק, בלי קריאות AI)
  "tests/regression/centralCore.test.ts",
];

const NEVER_AUTOMATIC = ["tests/live/**", "tests/e2e/**", "scripts/**"]; // scripts/live — בדיקות Live ידניות בלבד

for (const file of SAFE_TESTS) {
  if (/^tests\/(live|e2e)\/|^scripts\//.test(file)) {
    throw new Error(`${file} — בדיקות live/e2e וסקריפטים ידניים לא נכנסים ל-npm test`);
  }
}

export default defineConfig({
  test: {
    include: SAFE_TESTS,
    exclude: ["node_modules/**", ...NEVER_AUTOMATIC],
    globalSetup: ["tests/setup/globalSetup.ts"],
    setupFiles: ["tests/setup/isolate.ts"],
    environment: "node",
    pool: "forks",
  },
});
