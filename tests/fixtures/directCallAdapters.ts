/**
 * Fixture ל-tests/unit/sourceCalls.test.ts — adapters שלעולם לא מורצים, רק נקראים דרך toString()
 * אחרי שעברו את אותה טרנספורמציה של Vitest כמו קוד ה-src. ה"אסורים" מדמים הפרה: adapter שקורא
 * ישירות ל-createTask (כתיבת Monday) במקום לעבור דרך AgentTool.execute.
 */
import { createTask } from "../../src/integrations/monday/tasks.js";
import * as tasks from "../../src/integrations/monday/tasks.js";

type Input = { itemName: string; boardId?: string };

export const forbiddenDirect = async (input: Input) => createTask(input.itemName, input.boardId);
export const forbiddenNamespace = async (input: Input) => tasks.createTask(input.itemName, input.boardId);

const createTaskAction = async (input: Input) => input; // שם דומה, לא אותה פונקציה
export const allowedSimilarName = async (input: Input) => createTaskAction(input);
