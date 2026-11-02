/**
 * טיק רקע להשלמת פרטי קשר על איש הקשר המקושר (ר' leadContactSync.ts). התור ב-SQLite ולכן שורד ריסטרט — עם
 * הפעלה מיד מטפלים במה שהצטבר. בלי משימות פתוחות הטיק הוא שאילתת SQLite בלבד (אפס קריאות ל-Monday).
 */

import { finishJobRun, startJobRun } from "../db/repositories/systemHealth.js";
import { logger } from "../utils/logger.js";
import { processLeadContactSyncJobs, type SyncDeps } from "./leadContactSync.js";

const JOB_KEY = "lead_contact_sync";
const TICK_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inProgress = false;

export async function runLeadContactSyncTick(deps?: SyncDeps): Promise<void> {
  if (inProgress) return;
  inProgress = true;
  try {
    const r = await processLeadContactSyncJobs(deps);
    if (r.claimed > 0) {
      // job_runs רק כשבאמת היה מה לעבד — כדי שה-/health לא יוצף ברשומות ריקות כל 20 שניות
      const runId = startJobRun(JOB_KEY, "schedule");
      finishJobRun(runId, true);
      logger.info({ ...r }, "סנכרון איש קשר מקושר: סבב הושלם");
    }
  } catch (err) {
    const runId = startJobRun(JOB_KEY, "schedule");
    finishJobRun(runId, false, (err as Error).message);
    logger.error({ err }, "סנכרון איש קשר מקושר: כשל בלתי-צפוי בסבב — הטיק הבא ינסה שוב");
  } finally {
    inProgress = false;
  }
}

export function startLeadContactSyncSchedule(): void {
  if (timer) return;
  void runLeadContactSyncTick(); // התאוששות מיידית אחרי ריסטרט
  timer = setInterval(() => void runLeadContactSyncTick(), TICK_MS);
}

export function stopLeadContactSyncSchedule(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
