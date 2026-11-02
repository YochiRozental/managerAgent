/**
 * אפשרויות הבחירה הדינמיות של הטפסים — נטענות מ-Monday (תוויות עמודות, פרויקטים, שלבים), לא מרשימות
 * קשיחות. כשל בטעינה → null ("לא ידוע"): ה-UI מציג שדה בלי אפשרויות, והשרת לא חוסם על חברוּת (הפונקציה
 * ה-Action ממשיכה לאמת בעצמה מול Monday), חוץ מ-lead_product שנופל לרשימה הקשיחה הקיימת.
 */

import { userCan, TEAM_DIRECTORY, type IdentifiedUser } from "../../identity/index.js";
import { getColumnLabels } from "../../integrations/monday/opsWrite.js";
import { LEADS_BOARD_ID, LEAD_PRODUCT_OPTIONS, LEAD_SOURCE_OPTIONS } from "../../integrations/monday/leads.js";
import {
  BOARD_GENERAL_TASKS,
  fetchActiveProjects,
  getProjectStages,
  matchProjectsByQuery,
  type ProjectMeta,
  type ProjectStage,
} from "../../integrations/monday/opsRead.js";
import type { OptionsSource } from "./types.js";

export interface OptionsDeps {
  getColumnLabels?: (boardId: string, columnId: string) => Promise<string[]>;
  fetchActiveProjects?: () => Promise<ProjectMeta[]>;
  getProjectStages?: (projectId: string) => Promise<ProjectStage[]>;
}

function cleanLabels(labels: string[]): string[] {
  return labels.map((l) => l.trim()).filter((l) => l.length > 0);
}

/** בוחר פרויקט לפי שם מדויק, ואם אין — התאמה חד-משמעית. */
export function pickProject(projects: ProjectMeta[], name: string): ProjectMeta | null {
  const exact = projects.filter((p) => p.name === name);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const loose = matchProjectsByQuery(projects, name);
  return loose.length === 1 ? loose[0]! : null;
}

export async function resolveOptions(
  source: OptionsSource,
  user: IdentifiedUser,
  params: { project?: string } = {},
  deps: OptionsDeps = {},
): Promise<string[] | null> {
  const labelsOf = deps.getColumnLabels ?? getColumnLabels;
  try {
    switch (source) {
      case "lead_source": {
        const l = cleanLabels(await labelsOf(LEADS_BOARD_ID, "color1__1"));
        return l.length ? l : [...LEAD_SOURCE_OPTIONS];
      }
      case "lead_product": {
        const l = cleanLabels(await labelsOf(LEADS_BOARD_ID, "color5__1"));
        return l.length ? l : [...LEAD_PRODUCT_OPTIONS];
      }
      case "task_priority": {
        const l = cleanLabels(await labelsOf(BOARD_GENERAL_TASKS, "priority"));
        return l.length ? l : null;
      }
      case "people": {
        const members = TEAM_DIRECTORY.filter((m) => m.mondayUserId);
        // בלי task:manage מותר ליצור רק לעצמי (authorizeCreateTask) — לא מציעים אחרים.
        const allowed = userCan(user, "task:manage") || userCan(user, "lead:manage") ? members : members.filter((m) => m.key === user.key);
        return allowed.map((m) => m.name);
      }
      case "projects": {
        const projects = await (deps.fetchActiveProjects ?? fetchActiveProjects)();
        return [...new Set(projects.map((p) => p.name))].sort((a, b) => a.localeCompare(b, "he"));
      }
      case "stages": {
        const name = params.project?.trim();
        if (!name) return [];
        const projects = await (deps.fetchActiveProjects ?? fetchActiveProjects)();
        const project = pickProject(projects, name);
        if (!project) return [];
        const stages = await (deps.getProjectStages ?? getProjectStages)(project.itemId);
        return stages.map((s) => s.name);
      }
    }
  } catch {
    return source === "lead_product" ? [...LEAD_PRODUCT_OPTIONS] : null;
  }
}
