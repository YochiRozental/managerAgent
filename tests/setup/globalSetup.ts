/**
 * רץ פעם אחת לכל `npm test`, בתהליך הראשי: יוצר תיקיית temp אחת לכל ההרצה ומוחק אותה בסוף.
 * כל קובץ בדיקה מקבל בתוכה תת-תיקייה משלו (tests/setup/isolateDb.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    testTmpRoot: string;
  }
}

export default function setup(project: TestProject) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managerAgent-test-"));
  project.provide("testTmpRoot", root);
  return () => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
