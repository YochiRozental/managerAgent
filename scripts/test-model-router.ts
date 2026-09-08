/**
 * בדיקת ה-Model Router — לוגיקה מקומית בלבד, לא קורא ל-Anthropic ולא ל-Monday.
 * מריץ: npm run test:router
 */
import {
  DEFAULT_MODEL_FAST,
  DEFAULT_MODEL_SMART,
  addUsage,
  chooseModelForTask,
  estimateCostUsd,
  modelForTier,
  newUsageAcc,
  resolveModelConfig,
  shouldEscalateToSmart,
  type RouteContext,
} from "../src/ai/models.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    logger.info(`✅ ${msg}`);
  } else {
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

// ── ברירות מחדל ותצורה ──────────────────────────────────────────────────────
logger.info("— תצורה —");
assert(DEFAULT_MODEL_FAST === "claude-haiku-4-5-20251001", "ברירת מחדל FAST = Haiku 4.5");
assert(DEFAULT_MODEL_SMART === "claude-sonnet-5", "ברירת מחדל SMART = Sonnet 5");

const def = resolveModelConfig({});
assert(def.fast === DEFAULT_MODEL_FAST && def.smart === DEFAULT_MODEL_SMART, "בלי env — ברירות המחדל");
assert(def.costLogging === true, "בלי env — לוג עלות מופעל");

const overridden = resolveModelConfig({ MODEL_FAST: "custom-fast", MODEL_SMART: "custom-smart", AI_COST_LOGGING: "false" });
assert(overridden.fast === "custom-fast", "MODEL_FAST מ-env גובר");
assert(overridden.smart === "custom-smart", "MODEL_SMART מ-env גובר");
assert(overridden.costLogging === false, "AI_COST_LOGGING=false מכבה לוג עלות");

assert(modelForTier("fast", overridden) === "custom-fast", "modelForTier(fast) לפי הקונפיג שהוזרק");
assert(modelForTier("smart", overridden) === "custom-smart", "modelForTier(smart) לפי הקונפיג שהוזרק");

// ── ניתוב: פעולות פשוטות → FAST ─────────────────────────────────────────────
logger.info("— פעולות פשוטות → FAST —");
assert(route({ latestMessage: "בוקר טוב" }).tier === "fast", "'בוקר טוב' → FAST");
assert(route({ latestMessage: "כן" }).tier === "fast", "'כן' (אישור קצר) → FAST");
assert(route({ latestMessage: "סיימתי את התכניות של בלומינג" }).tier === "fast", "דיווח ביצוע פשוט → FAST");
assert(route({ latestMessage: "מה יש לי היום?" }).tier === "fast", "'מה יש לי היום' → FAST");
assert(route({ latestMessage: "תעדכן שהתחלתי לעבוד על ההגשה" }).tier === "fast", "עדכון סטטוס → FAST");
assert(
  route({ latestMessage: "מה תקוע אצלי?", canSeeAllWork: false }).tier === "fast",
  "עובד רגיל ששואל 'מה תקוע' → FAST (אין לו ראיית כל-המשרד)",
);

// ── ניתוב: פעולות מורכבות → SMART ───────────────────────────────────────────
logger.info("— פעולות מורכבות → SMART —");
assert(route({ latestMessage: "תנתח לי את מצב הפרויקט של סלונים" }).tier === "smart", "'תנתח' → SMART");
assert(route({ latestMessage: "תכנן לי סדר עבודה למחר" }).tier === "smart", "'תכנן סדר עבודה' → SMART");
assert(route({ latestMessage: "מה עדיף — להתחיל ברישוי או בתכניות?" }).tier === "smart", "בחירה בין אפשרויות → SMART");
assert(route({ latestMessage: "תמליץ לי במה להתמקד השבוע" }).tier === "smart", "בקשת המלצה → SMART");
assert(
  route({ latestMessage: "מה תקוע במשרד?", canSeeAllWork: true }).tier === "smart",
  "מוטי שואל 'מה תקוע במשרד' → SMART (שאלת בקרה־על)",
);
assert(
  route({ latestMessage: "מה המצב הכללי של המכירות והגבייה?", canSeeAllWork: true }).tier === "smart",
  "מוטי — סקירת מכירות/גבייה → SMART",
);
assert(
  route({ latestMessage: "a".repeat(300) }).tier === "smart",
  "הודעה ארוכה מאוד (>220 תווים) → SMART",
);
assert(route({ latestMessage: "מה קורה פה?", historyLength: 20 }).tier === "smart", "שיחה עמוקה (14+ הודעות) → SMART");

// trivial גובר על אורך אבל לא על מילת-מפתח
assert(route({ latestMessage: "היי" }).reason === "trivial", "הודעה טריוויאלית מסומנת 'trivial'");

// ── fallback ────────────────────────────────────────────────────────────────
logger.info("— fallback FAST→SMART —");
assert(
  shouldEscalateToSmart({ attemptedTier: "fast", failed: true, sideEffectsCount: 0 }) === true,
  "FAST נכשל בלי תופעות לוואי → מסלים ל-SMART",
);
assert(
  shouldEscalateToSmart({ attemptedTier: "fast", failed: false, sideEffectsCount: 0 }) === false,
  "FAST הצליח → לא מסלים (אין קריאת AI שנייה מיותרת)",
);
assert(
  shouldEscalateToSmart({ attemptedTier: "fast", failed: true, sideEffectsCount: 1 }) === false,
  "FAST נכשל אבל כבר בוצעה כתיבה ל-Monday → לא מסלים (לא מכפילים פעולות)",
);
assert(
  shouldEscalateToSmart({ attemptedTier: "smart", failed: true, sideEffectsCount: 0 }) === false,
  "כבר רצנו SMART → אין הסלמה נוספת (אין retry loop)",
);

// ── עלות ────────────────────────────────────────────────────────────────────
logger.info("— חישוב עלות משוער —");
const u = newUsageAcc();
addUsage(u, { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0 });
assert(estimateCostUsd("claude-haiku-4-5-20251001", u) === 6, "Haiku: 1M in + 1M out = $1 + $5 = $6");
assert(estimateCostUsd("claude-sonnet-5", u) === 18, "Sonnet: 1M in + 1M out = $3 + $15 = $18");
assert(estimateCostUsd("some-unknown-model", u) === null, "מודל לא מוכר → null (לא ממציאים מחיר)");

const acc = newUsageAcc();
addUsage(acc, { input_tokens: 100, output_tokens: 50 });
addUsage(acc, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 });
assert(acc.input === 200 && acc.output === 100 && acc.cacheRead === 20, "addUsage מצטבר על פני מספר סבבים");
addUsage(acc, null);
assert(acc.input === 200, "addUsage(null) לא מפיל ולא משנה");

logger.info("");
if (failures > 0) {
  logger.error(`${failures} בדיקות נכשלו ❌`);
  process.exit(1);
}
logger.info("כל בדיקות ה-router עברו ✅");
