/**
 * שלב "התראות ותזכורות" (2026-10-19) — mondayItemUrl: קישור "פתח ב-Monday" להתראה/נודג' לפי
 * item_id+item_source בלבד, בלי קריאת API. אותו מיפוי בורדים בדיוק כמו ה-url על כל OpsTask
 * (BOARD_GENERAL_TASKS/BOARD_PROJECT_STAGE_TASKS) — פונקציה טהורה, לא תלויה ב-DB/רשת.
 */

import "dotenv/config";
import { describe, expect, it } from "vitest";
import {
  BOARD_GENERAL_TASKS,
  BOARD_PROJECT_STAGE_TASKS,
  mondayItemUrl,
} from "../../src/integrations/monday/opsRead.js";

describe("mondayItemUrl", () => {
  it("משימה כללית (general) → BOARD_GENERAL_TASKS", () => {
    expect(mondayItemUrl("12345", "general")).toBe(
      `https://gottlieb-league.monday.com/boards/${BOARD_GENERAL_TASKS}/pulses/12345`,
    );
  });

  it("משימת שלב-פרויקט (project_stage) → BOARD_PROJECT_STAGE_TASKS", () => {
    expect(mondayItemUrl("67890", "project_stage")).toBe(
      `https://gottlieb-league.monday.com/boards/${BOARD_PROJECT_STAGE_TASKS}/pulses/67890`,
    );
  });
});
