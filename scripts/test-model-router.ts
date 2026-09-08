/**
 * בדיקת ה-router — בחירת tier (FAST/SMART) והחלטת ה-fallback. לוגיקה מקומית בלבד.
 * מריץ: npm run test:router
 */
import {
  chooseModelForTask,
  shouldEscalateToSmart,
  type RouteContext,
} from "../src/ai/models.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) logger.info(`✅ ${msg}`);
  else {
    failures++;
    logger.error(`❌ ${msg}`);
  }
}

function route(partial: Partial<RouteContext> & { latestMessage: string }) {
  return chooseModelForTask({
    useCase: "ops_chat",
    historyLength: 2,
    canSeeAllWork: false,
    ...partial,
  });
}

// ── פעולות פשוטות → FAST ────────────────────────────────────────────────────
logger.info("— פעולות פשוטות → FAST —");
assert(route({ latestMessage: "בוקר טוב" }).tier === "fast", "'בוקר טוב' → FAST");
assert(route({ latestMessage: "כן" }).tier === "fast", "'כן' → FAST");
assert(route({ latestMessage: "בוקר טוב" }).reason === "trivial", "'בוקר טוב' מסומן trivial");
assert(route({ latestMessage: "סיימתי את התכניות של בלומינג" }).tier === "fast", "דיווח ביצוע → FAST");
assert(route({ latestMessage: "מה יש לי היום?" }).tier === "fast", "'מה יש לי היום' → FAST");
assert(route({ latestMessage: "תעדכן שהתחלתי לעבוד על ההגשה" }).tier === "fast", "עדכון סטטוס → FAST");
assert(
  route({ latestMessage: "מה תקוע אצלי?", canSeeAllWork: false }).tier === "fast",
  "עובד רגיל 'מה תקוע' → FAST (אין ראיית כל-המשרד)",
);

// ── פעולות מורכבות → SMART ──────────────────────────────────────────────────
logger.info("— פעולות מורכבות → SMART —");
assert(route({ latestMessage: "תנתח לי את מצב הפרויקט של סלונים" }).tier === "smart", "'תנתח' → SMART");
assert(route({ latestMessage: "תכנן לי סדר עבודה למחר" }).tier === "smart", "'תכנן סדר עבודה' → SMART");
assert(route({ latestMessage: "מה עדיף — להתחיל ברישוי או בתכניות?" }).tier === "smart", "בחירה בין אפשרויות → SMART");
assert(route({ latestMessage: "תמליץ לי במה להתמקד השבוע" }).tier === "smart", "בקשת המלצה → SMART");
assert(
  route({ latestMessage: "מה תקוע במשרד?", canSeeAllWork: true }).tier === "smart",
  "מוטי 'מה תקוע במשרד' → SMART (שאלת בקרה־על)",
);
assert(route({ latestMessage: "a".repeat(300) }).tier === "smart", "הודעה >220 תווים → SMART");
assert(route({ latestMessage: "מה קורה פה?", historyLength: 20 }).tier === "smart", "שיחה עמוקה (14+) → SMART");

// ── fallback FAST→SMART ─────────────────────────────────────────────────────
logger.info("— fallback —");
assert(
  shouldEscalateToSmart({ attemptedTier: "fast", failed: true, sideEffectsCount: 0 }),
  "FAST נכשל בלי תופעות לוואי → מסלים",
);
assert(
  !shouldEscalateToSmart({ attemptedTier: "fast", failed: false, sideEffectsCount: 0 }),
  "FAST הצליח → לא מסלים (אין קריאת AI שנייה מיותרת)",
);
assert(
  !shouldEscalateToSmart({ attemptedTier: "fast", failed: true, sideEffectsCount: 1 }),
  "FAST נכשל אבל בוצעה כתיבה → לא מסלים (לא מכפילים פעולות)",
);
assert(
  !shouldEscalateToSmart({ attemptedTier: "smart", failed: true, sideEffectsCount: 0 }),
  "כבר רצנו SMART → אין הסלמה נוספת (אין retry loop)",
);

logger.info("");
if (failures > 0) {
  logger.error(`${failures} בדיקות נכשלו ❌`);
  process.exit(1);
}
logger.info("כל בדיקות ה-router עברו ✅");
