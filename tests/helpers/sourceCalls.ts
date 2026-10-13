/**
 * זיהוי קריאה ישירה לפונקציה בתוך `fn.toString()` — עמיד לטרנספורמציה של Vitest.
 *
 * ב-tsx קריאה לפונקציה מיובאת נראית `createTask(x)`. ב-Vitest (vite SSR) היא נכתבת מחדש ל-
 * `(0,__vite_ssr_import_N__.createTask)(x)` — ולכן `src.includes("createTask(")` מפסיק לתפוס אותה.
 * הביטוי כאן תופס את שתי הצורות (וגם `obj.createTask(x)`), ולא תופס שם ארוך יותר כמו `createTaskAction(`.
 * מאומת ב-tests/unit/sourceCalls.test.ts מול פונקציות שעברו את אותה טרנספורמציה.
 */
export function callsDirectly(src: string, fnName: string): boolean {
  return new RegExp(`${fnName}\\s*\\)?\\s*\\(`).test(src);
}
