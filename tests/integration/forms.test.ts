/**
 * טפסי יצירה בצ'אט — שירות, אידמפוטנטיות לפי מזהה הטופס, הרשאות, "אין" בליד, API, חיבור ל-runOpsChat והיסטוריה.
 * כל כתיבה ל-Monday מוזרקת (fake); הרשת חסומה ע"י tests/setup. ה-DB זמני ומבודד.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/db.js";
import { appendChatTurn } from "../../src/db/repositories/chatHistory.js";
import { getFormRequest } from "../../src/db/repositories/formRequests.js";
import { resolveUserByKey } from "../../src/identity/index.js";
import type { RunModelFn } from "../../src/ai/agentLoop.js";
import type { NormToolCall, RunModelParams } from "../../src/ai/providers/types.js";
import type { createLeadAction, createProjectStageAction, createTaskAction } from "../../src/ops/actions.js";
import { runOpsChat, type ChatMessage } from "../../src/ops/chat.js";
import { FormError, cancelForm, getForm, openForm, submitForm, type FormServiceDeps } from "../../src/ops/forms/service.js";
import type { ProjectMeta, ProjectStage } from "../../src/integrations/monday/opsRead.js";
import { handleFormsRequest } from "../../src/server/formsApi.js";
import { loadChatSession } from "../../src/server/chatSession.js";

const dov = resolveUserByKey("dov")!;
const ruchama = resolveUserByKey("ruchama")!;
const goldi = resolveUserByKey("goldi")!;
const moti = resolveUserByKey("moti")!;

const PROJECTS: ProjectMeta[] = [
  { itemId: "9001", name: "בלומינג", owner: "דוב שפירא", ownerIds: ["62982081"], status: "בעבודה", groupTitle: "g" },
  { itemId: "9002", name: "מגדל השרון", owner: "דוב שפירא", ownerIds: ["62982081"], status: "בעבודה", groupTitle: "g" },
];
const STAGES: ProjectStage[] = [
  { id: "7001", name: "שלב 1 - תכנון", subitems: [] },
  { id: "7002", name: "שלב 2 - היתר", subitems: [] },
];
const OPTIONS = {
  getColumnLabels: async (_b: string, c: string) =>
    c === "color5__1" ? ["מעונות יום", "בית ספר", "", "מקווה"] : c === "color1__1" ? ["אתר", "הפניה"] : ["קריטי ⚠️", "גבוה", "נמוך"],
  fetchActiveProjects: async () => PROJECTS,
  getProjectStages: async () => STAGES,
};

let seq = 0;
const nextSeed = () => `seed-${Date.now()}-${seq++}`;

function taskFake() {
  return vi.fn(async (_u: unknown, input: { taskName: string }) => ({
    ok: true as const,
    itemId: "5550001",
    itemName: input.taskName,
    source: "general" as const,
    assigneeName: "x",
    message: `נוצרה משימה "${input.taskName}"`,
    deduped: false,
  }));
}

function deps(over: FormServiceDeps = {}): FormServiceDeps & { history: string[] } {
  const history: string[] = [];
  return { options: OPTIONS, appendHistory: (_u, _s, t) => void history.push(t), ...over, history };
}

const openTask = (user = dov, input: Record<string, unknown> = { taskName: "להתקשר ליועץ" }, sessionId = "s-1") =>
  openForm(user, "task", input, { sessionId, seed: nextSeed() });

beforeEach(() => {
  db.exec("DELETE FROM form_requests; DELETE FROM commitments; DELETE FROM chat_messages;");
});

describe("פתיחה, בעלות ו-idempotency של הפתיחה", () => {
  it("מזהה דטרמיניסטי לפי seed — אותה הודעה (retry/fallback) לא פותחת טופס שני", () => {
    const a = openForm(dov, "task", { taskName: "x" }, { sessionId: "s", seed: "m1" });
    const b = openForm(dov, "task", { taskName: "x" }, { sessionId: "s", seed: "m1" });
    const c = openForm(dov, "task", { taskName: "x" }, { sessionId: "s", seed: "m2" });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM form_requests").get()).toEqual({ n: 2 });
  });

  it("מילוי מראש נשמר, והטופס נראה רק לבעליו", () => {
    const f = openTask(dov, { taskName: "להתקשר", dueDate: "2026-11-10" });
    expect(f.status).toBe("open");
    expect(f.values).toMatchObject({ taskName: "להתקשר", dueDate: "2026-11-10", scope: "general" });
    expect(getForm(dov, f.id)?.id).toBe(f.id);
    expect(getForm(ruchama, f.id)).toBeNull();
  });

  it("הרשאה: רוחמה לא פותחת טופס שלב/ליד; דוב פותח ליד", () => {
    expect(() => openForm(ruchama, "stage", {}, { sessionId: "s" })).toThrow(FormError);
    expect(() => openForm(goldi, "task", {}, { sessionId: "s" })).toThrow(/הרשאה/);
    expect(openForm(dov, "lead", {}, { sessionId: "s" }).kind).toBe("lead");
    expect(() => openForm(ruchama, "lead", {}, { sessionId: "s" })).toThrow(/הרשאה/);
  });
});

describe("שליחת משימה", () => {
  it("יוצרת דרך createTaskAction הקיימת, בלי dedup לפי תוכן, ומציגה הצלחה רק אחרי החזרה", async () => {
    const fake = taskFake();
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f = openTask(dov, { taskName: "להתקשר ליועץ", dueDate: "2026-11-10" });
    const out = await submitForm(dov, f.id, { values: { ...f.values } }, d);

    expect(fake).toHaveBeenCalledTimes(1);
    const [, input, passedDeps] = fake.mock.calls[0] as unknown as [unknown, Record<string, unknown>, { getCachedCreation: () => unknown }];
    expect(input).toMatchObject({ taskName: "להתקשר ליועץ", dueDate: "2026-11-10", project: undefined, taskKind: undefined });
    expect(passedDeps.getCachedCreation()).toBeNull(); // הדה-דופליקציה לפי תוכן מנוטרלת בנתיב הטופס

    expect(out.alreadySubmitted).toBe(false);
    expect(out.form.status).toBe("submitted");
    expect(out.form.result?.url).toContain("/pulses/5550001");
    expect(out.confirmation).toContain("[פתח ב-Monday](");
    expect(d.history).toEqual([out.confirmation]); // נשמר גם בהיסטוריית השיחה
  });

  it("scope=stage מעביר taskKind/stage; scope=project מעביר taskKind=project", async () => {
    const fake = taskFake();
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f1 = openTask(dov, { taskName: "א", project: "בלומינג", stage: "שלב 2 - היתר" });
    await submitForm(dov, f1.id, { values: f1.values }, d);
    expect(fake.mock.calls[0]![1]).toMatchObject({ project: "בלומינג", taskKind: "stage", stage: "שלב 2 - היתר" });
    const f2 = openTask(dov, { taskName: "ב", project: "בלומינג", taskKind: "project" });
    await submitForm(dov, f2.id, { values: f2.values }, d);
    expect(fake.mock.calls[1]![1]).toMatchObject({ project: "בלומינג", taskKind: "project", stage: undefined });
  });

  it("לחיצה כפולה על אותו טופס לא יוצרת שוב ומחזירה את התוצאה השמורה", async () => {
    const fake = taskFake();
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f = openTask();
    const a = await submitForm(dov, f.id, { values: f.values }, d);
    const b = await submitForm(dov, f.id, { values: f.values }, d);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(b.alreadySubmitted).toBe(true);
    expect(b.form.result).toEqual(a.form.result);
    expect(d.history).toHaveLength(1);
  });

  it("שתי שליחות מקבילות — רק אחת מבצעת", async () => {
    const fake = vi.fn(async (_u: unknown, input: { taskName: string }) => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true as const, itemId: "1", itemName: input.taskName, source: "general" as const, assigneeName: "x", message: "נוצר", deduped: false };
    });
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f = openTask();
    const results = await Promise.allSettled([
      submitForm(dov, f.id, { values: f.values }, d),
      submitForm(dov, f.id, { values: f.values }, d),
    ]);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled" && !r.value.alreadySubmitted)).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (loser) expect((loser.reason as FormError).status).toBe(409);
  });

  it("שני טפסים נפרדים עם תוכן זהה יוצרים שני פריטים (יצירה מכוונת של זהים)", async () => {
    const fake = taskFake();
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const a = openTask();
    const b = openTask();
    await submitForm(dov, a.id, { values: a.values }, d);
    await submitForm(dov, b.id, { values: b.values }, d);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("כשל ביצירה → הטופס חוזר לפתוח עם השגיאה, ואפשר לנסות שוב; אין הצלחה מזויפת", async () => {
    const fake = vi
      .fn()
      .mockRejectedValueOnce(new Error("Monday לא זמין"))
      .mockResolvedValueOnce({ ok: true, itemId: "9", itemName: "x", source: "general", assigneeName: "x", message: "נוצר", deduped: false });
    const findCreated = vi.fn(async () => []);
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction, findCreated });
    const f = openTask();
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toMatchObject({ status: 422, message: "Monday לא זמין" });
    expect(findCreated).not.toHaveBeenCalled(); // ניסיון ראשון — אין מה להתאים
    expect(getForm(dov, f.id)).toMatchObject({ status: "open", error: "Monday לא זמין", result: null });
    expect(d.history).toHaveLength(0);
    const ok = await submitForm(dov, f.id, { values: f.values }, d);
    expect(ok.form.status).toBe("submitted");
    expect(fake).toHaveBeenCalledTimes(2);
    expect(findCreated).toHaveBeenCalledTimes(1); // הניסיון השני מוודא קודם שהראשון לא יצר את הפריט
  });

  it("ולידציה בשרת: חסר שדה חובה / scope בלי פרויקט — 400, בלי claim ובלי יצירה", async () => {
    const fake = taskFake();
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f = openTask();
    await expect(submitForm(dov, f.id, { values: {} }, d)).rejects.toMatchObject({ status: 400, fieldErrors: { taskName: "שדה חובה" } });
    await expect(submitForm(dov, f.id, { values: { taskName: "x", scope: "project" } }, d)).rejects.toMatchObject({
      fieldErrors: { project: "שדה חובה" },
    });
    expect(fake).not.toHaveBeenCalled();
    expect(getFormRequest(f.id)!.status).toBe("open");
  });

  it("ערך שאינו ברשימת Monday הדינמית נדחה (פרויקט שלא קיים, שלב שלא בפרויקט, תעדוף לא קיים)", async () => {
    const fake = taskFake();
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f = openTask();
    await expect(
      submitForm(dov, f.id, { values: { taskName: "x", scope: "stage", project: "לא קיים", stage: "שלב 1 - תכנון" } }, d),
    ).rejects.toMatchObject({ fieldErrors: { project: expect.any(String) } });
    await expect(
      submitForm(dov, f.id, { values: { taskName: "x", scope: "stage", project: "בלומינג", stage: "שלב 99" } }, d),
    ).rejects.toMatchObject({ fieldErrors: { stage: expect.any(String) } });
    await expect(submitForm(dov, f.id, { values: { taskName: "x", scope: "general", priority: "דחוף מאוד" } }, d)).rejects.toMatchObject({
      fieldErrors: { priority: expect.any(String) },
    });
    expect(fake).not.toHaveBeenCalled();
  });

  it("רוחמה (planner) לא רואה אחרים כאפשרות 'אחראי', והפעולה האמיתית נשארת הסמכות להרשאה", async () => {
    const { resolveOptions } = await import("../../src/ops/forms/options.js");
    expect(await resolveOptions("people", ruchama, {}, OPTIONS)).toEqual(["רוחמה מינצר"]);
    expect((await resolveOptions("people", dov, {}, OPTIONS))!.length).toBeGreaterThan(3);
    // הקצאה לאחר ע'י מי שאין לו task:manage נחסמת כבר בולידציית השרת (לפני כל קריאה ל-Monday)
    const denied = vi.fn();
    const f = openTask(ruchama, { taskName: "x", assignee: "דוב שפירא" });
    await expect(
      submitForm(ruchama, f.id, { values: f.values }, deps({ createTaskAction: denied as unknown as typeof createTaskAction })),
    ).rejects.toMatchObject({ status: 400, fieldErrors: { assignee: expect.any(String) } });
    expect(denied).not.toHaveBeenCalled();
    expect(getFormRequest(f.id)!.status).toBe("open");
    // ושגיאת הרשאה שמגיעה מה-Action עצמו (סמכות סופית) → 422 והטופס נשאר פתוח
    const g = openTask(ruchama, { taskName: "x" });
    const refuse = vi.fn().mockRejectedValue(new Error("אין לך הרשאה ליצור משימות"));
    await expect(
      submitForm(ruchama, g.id, { values: g.values }, deps({ createTaskAction: refuse as unknown as typeof createTaskAction })),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("הרשאה") });
    expect(getFormRequest(g.id)!.status).toBe("open");
  });
});

describe("ביטול, בעלות והרשאה בשליחה", () => {
  it("ביטול: open→cancelled; שליחה אחרי ביטול נדחית; ביטול אחרי שליחה לא משנה", async () => {
    const fake = taskFake();
    const d = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f = openTask();
    expect(cancelForm(dov, f.id).status).toBe("cancelled");
    await expect(submitForm(dov, f.id, { values: f.values }, d)).rejects.toMatchObject({ status: 409 });
    const g = openTask();
    await submitForm(dov, g.id, { values: g.values }, d);
    expect(cancelForm(dov, g.id).status).toBe("submitted");
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("משתמש אחר לא יכול לשלוח/לבטל טופס שאינו שלו", async () => {
    const f = openTask(dov);
    await expect(submitForm(ruchama, f.id, { values: f.values }, deps())).rejects.toMatchObject({ status: 404 });
    expect(() => cancelForm(ruchama, f.id)).toThrow(FormError);
    expect(getFormRequest(f.id)!.status).toBe("open");
  });

  it("הרשאה נבדקת גם בשליחה (לא רק בפתיחה)", async () => {
    const f = openForm(dov, "stage", {}, { sessionId: "s", seed: nextSeed() });
    // טופס של דוב — רוחמה לא יכולה להשתמש בו בכל מקרה (בעלות); הרשאה: משתמש שאיבד הרשאה בינתיים
    db.prepare("UPDATE form_requests SET user_key = 'goldi' WHERE id = ?").run(f.id);
    await expect(submitForm(goldi, f.id, { values: { project: "בלומינג", name: "x" } }, deps())).rejects.toMatchObject({ status: 403 });
  });
});

describe("שלב והתחייבות", () => {
  it("שלב: createProjectStageAction עם פרויקט ושם; קישור ללוח השלבים", async () => {
    const fake = vi.fn(async () => ({ ok: true as const, itemId: "6001", itemName: "שלב חדש", project: "בלומינג", message: 'נוצר שלב חדש "שלב חדש"', deduped: false }));
    const f = openForm(dov, "stage", { project: "בלומינג", name: "שלב חדש" }, { sessionId: "s", seed: nextSeed() });
    const out = await submitForm(dov, f.id, { values: f.values }, deps({ createProjectStageAction: fake as unknown as typeof createProjectStageAction }));
    expect(fake.mock.calls[0]![1]).toEqual({ project: "בלומינג", stageName: "שלב חדש" });
    expect(out.form.result?.url).toContain("/boards/1550734531/pulses/6001");
  });

  it("התחייבות: נשמרת ב-SQLite (לא Monday), בלי קישור; התחייבות לעצמך נדחית", async () => {
    const f = openForm(dov, "commitment", { toWhom: "לקוח כהן", what: "לשלוח הצעה", dueDate: "2026-11-12" }, { sessionId: "s", seed: nextSeed() });
    const out = await submitForm(dov, f.id, { values: f.values }, deps());
    expect(out.form.result?.url).toBeUndefined();
    expect(out.confirmation).toContain("לא נשלח לאף אחד");
    expect(db.prepare("SELECT to_whom, what, due_date FROM commitments WHERE created_by = 'dov'").all()).toEqual([
      { to_whom: "לקוח כהן", what: "לשלוח הצעה", due_date: "2026-11-12" },
    ]);

    const self = openForm(dov, "commitment", { toWhom: "דוב שפירא", what: "x" }, { sessionId: "s", seed: nextSeed() });
    await expect(submitForm(dov, self.id, { values: self.values }, deps())).rejects.toMatchObject({ status: 422 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM commitments").get()).toEqual({ n: 1 });
  });
});

describe("ליד", () => {
  const LEAD_OK = { contactName: "דנה בן דוד", phone: "050-1234567", projectName: "בית פרטי ברמת גן", projectType: "בית ספר" };
  const leadFake = () =>
    vi.fn(async () => ({ ok: true as const, itemId: "8001", itemName: "בית פרטי ברמת גן", message: 'נוצר ליד "בית פרטי ברמת גן"', deduped: false }));
  const enqueue = () => vi.fn(() => true);
  const openLead = () => openForm(dov, "lead", {}, { sessionId: "s", seed: nextSeed() });
  const leadDeps = (over: FormServiceDeps = {}) =>
    deps({ createLeadAction: leadFake() as unknown as typeof createLeadAction, enqueueContactSync: enqueue(), ...over });

  it("שם הפריט = שם הפרויקט/הליד; איש הקשר בעמודותיו (פיצול שם); סוג פרויקט מרשימת Monday הדינמית (כולל 'בית ספר' שלא ברשימה הקשיחה)", async () => {
    const fake = leadFake();
    const f = openLead();
    const out = await submitForm(dov, f.id, { values: { ...LEAD_OK, email: "d@x.co" } }, leadDeps({ createLeadAction: fake as unknown as typeof createLeadAction }));
    const [, input, passed] = fake.mock.calls[0] as unknown as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({
      itemName: "בית פרטי ברמת גן",
      firstName: "דנה",
      lastName: "בן דוד",
      phone: "0501234567", // ספרות בלבד — Monday דוחה מקפים (נמצא בבדיקה חיה)
      email: "d@x.co",
      product: "בית ספר",
    });
    expect(input.extraColumnValues).toBeUndefined();
    expect(passed.productOptions).toEqual(["מעונות יום", "בית ספר", "מקווה"]); // התווית הריקה סוננה
    expect((passed.getCachedCreation as () => unknown)()).toBeNull();
    expect(out.form.result?.url).toContain("/boards/1550734525/pulses/8001");
  });

  it("ווצאפ שונה מהנייד → עמודת הווצאפ ישירות (בלי תיבת הסימון שאוטומציית Monday משתמשת בה להעתקת הנייד) + משימת רקע לאיש הקשר המקושר (בלי המתנה)", async () => {
    const fake = leadFake();
    const enq = enqueue();
    const f = openLead();
    const out = await submitForm(dov, f.id, { values: { ...LEAD_OK, whatsapp: "052-7654321" } }, leadDeps({ createLeadAction: fake as unknown as typeof createLeadAction, enqueueContactSync: enq }));
    const input = fake.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.whatsapp).toBe("0527654321");
    expect(input.whatsappSameAsPhone).toBe(false);
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0]![0]).toMatchObject({
      idemKey: `form:${f.id}`,
      leadItemId: "8001",
      source: "form_create",
      userKey: "dov",
      fields: { whatsapp: { old: null, new: "0527654321" } },
    });
    expect(out.form.result?.notes?.[0]).toContain("ברקע");
    expect(out.confirmation).toContain("ℹ️");
  });

  it("ווצאפ זהה לנייד (גם בפורמט +972) → תיבת '?מקבל ווצאפ' בלבד, בלי כתיבה כפולה לעמודת הווצאפ", async () => {
    const fake = leadFake();
    const f = openLead();
    await submitForm(dov, f.id, { values: { ...LEAD_OK, whatsapp: "+972 50 123 4567" } }, leadDeps({ createLeadAction: fake as unknown as typeof createLeadAction }));
    const input = fake.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.whatsapp).toBeUndefined();
    expect(input.whatsappSameAsPhone).toBe(true);
  });

  it("לחיצה כפולה על טופס ליד עם ווצאפ מכניסה לתור פעם אחת בלבד", async () => {
    const enq = enqueue();
    const d = leadDeps({ enqueueContactSync: enq });
    const f = openLead();
    await submitForm(dov, f.id, { values: { ...LEAD_OK, whatsapp: "052-7654321" } }, d);
    await submitForm(dov, f.id, { values: { ...LEAD_OK, whatsapp: "052-7654321" } }, d);
    expect(enq).toHaveBeenCalledTimes(1);
  });

  it('"אין" מפורש במייל/ווצאפ מתועד ב-Update; שדה שלא מולא — לא; ואין עדכון איש קשר כשאין ווצאפ', async () => {
    const update = vi.fn(async () => undefined);
    const fake = leadFake();
    const sync = enqueue();
    const d = leadDeps({ createLeadAction: fake as unknown as typeof createLeadAction, addUpdate: update, enqueueContactSync: sync });

    const a = openLead();
    await submitForm(dov, a.id, { values: { ...LEAD_OK }, none: { email: true, whatsapp: true } }, d);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toContain("אין כתובת מייל");
    expect(update.mock.calls[0]![1]).toContain("אין מספר ווצאפ");
    const inputA = fake.mock.calls[0]![1] as Record<string, unknown>;
    expect(inputA.email).toBeUndefined(); // לא נוצר ערך פיקטיבי
    expect(inputA.whatsapp).toBeUndefined();
    expect(inputA.whatsappSameAsPhone).toBe(false);
    expect(sync).not.toHaveBeenCalled();

    update.mockClear();
    const b = openLead();
    await submitForm(dov, b.id, { values: { ...LEAD_OK } }, d); // לא מולא ולא סומן
    expect(update).not.toHaveBeenCalled();

    update.mockClear();
    const c = openLead();
    await submitForm(dov, c.id, { values: { ...LEAD_OK, email: "a@b.co" }, none: { whatsapp: true } }, d);
    expect(update.mock.calls[0]![1]).toContain("אין מספר ווצאפ");
    expect(update.mock.calls[0]![1]).not.toContain("מייל");
  });

  it('כשל בכתיבת ה-Update אחרי יצירה מוצלחת → הליד נוצר, עם אזהרה (לא כשל)', async () => {
    const f = openLead();
    const out = await submitForm(
      dov,
      f.id,
      { values: { ...LEAD_OK }, none: { email: true } },
      leadDeps({
        addUpdate: async () => {
          throw new Error("rate limit");
        },
      }),
    );
    expect(out.form.status).toBe("submitted");
    expect(out.form.result?.warnings?.[0]).toContain("rate limit");
    expect(out.confirmation).toContain("⚠️");
  });

  it("ולידציה: ארבעת השדות חובה, טלפון/מייל תקינים, סוג פרויקט מחוץ לרשימה נדחה — בלי יצירה", async () => {
    const fake = leadFake();
    const d = leadDeps({ createLeadAction: fake as unknown as typeof createLeadAction });
    const f = openLead();
    await expect(submitForm(dov, f.id, { values: {} }, d)).rejects.toMatchObject({
      fieldErrors: { contactName: "שדה חובה", phone: "שדה חובה", projectName: "שדה חובה", projectType: "שדה חובה" },
    });
    await expect(submitForm(dov, f.id, { values: { ...LEAD_OK, phone: "1" } }, d)).rejects.toMatchObject({ fieldErrors: { phone: expect.any(String) } });
    await expect(submitForm(dov, f.id, { values: { ...LEAD_OK, email: "zzz" } }, d)).rejects.toMatchObject({ fieldErrors: { email: expect.any(String) } });
    await expect(submitForm(dov, f.id, { values: { ...LEAD_OK, projectType: "משהו אחר" } }, d)).rejects.toMatchObject({
      fieldErrors: { projectType: expect.any(String) },
    });
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("חיבור לצ'אט (runOpsChat)", () => {
  type Step = { text?: string; toolCalls?: { name: string; input?: unknown }[] };
  function scripted(steps: Step[]) {
    const calls: RunModelParams[] = [];
    let i = 0;
    const fn: RunModelFn = async (params) => {
      calls.push(params);
      const step = steps[Math.min(i++, steps.length - 1)]!;
      const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 };
      if (step.toolCalls) {
        const tcs: NormToolCall[] = step.toolCalls.map((t, k) => ({ id: `tc_${i}_${k}`, name: t.name, input: t.input ?? {} }));
        return { text: "", toolCalls: tcs, assistantContent: tcs.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input })), usage };
      }
      return { text: step.text ?? "", toolCalls: [], assistantContent: [{ type: "text" as const, text: step.text ?? "" }], usage };
    };
    return { fn, calls };
  }
  const CONFIG = { fast: { provider: "anthropic" as const, model: "m-fast" }, smart: { provider: "anthropic" as const, model: "m-smart" }, costLogging: false };
  const msg = (t: string): ChatMessage[] => [{ role: "user", content: t }];
  const run = (user: typeof dov, steps: Step[], text = "תפתח משימה", clientMessageId = nextSeed()) => {
    const m = scripted(steps);
    return runOpsChat(user, msg(text), { session: "s-chat", clientMessageId, _runModel: m.fn, _config: CONFIG }).then((r) => ({ r, ...m }));
  };

  it("בקשת יצירת משימה פותחת טופס ממולא-מראש; לא נוצר דבר; הטקסט קבוע ולא של המודל", async () => {
    const { r } = await run(dov, [
      { toolCalls: [{ name: "create_task", input: { taskName: "להתקשר ליועץ", project: "בלומינג", taskKind: "stage" } }] },
      { text: "יצרתי את המשימה בהצלחה!" },
    ]);
    expect(r.form).toMatchObject({ kind: "task", status: "open", values: { taskName: "להתקשר ליועץ", scope: "stage", project: "בלומינג" } });
    expect(r.reply).toContain("פתחתי טופס");
    expect(r.reply).not.toContain("יצרתי");
    expect(r.actions).toEqual([]);
    expect(getFormRequest(r.form!.id)).not.toBeNull();
  });

  it("אותה הודעה (אותו clientMessageId) בריצה שנייה → אותו טופס, לא שני טפסים", async () => {
    const id = nextSeed();
    const step: Step[] = [{ toolCalls: [{ name: "create_task", input: { taskName: "x" } }] }, { text: "ok" }];
    const a = await run(dov, step, "תפתח משימה", id);
    const b = await run(dov, step, "תפתח משימה", id);
    expect(b.r.form!.id).toBe(a.r.form!.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM form_requests").get()).toEqual({ n: 1 });
  });

  it("טופס אחד בהודעה: קריאה לסוג שני באותה הודעה נדחית", async () => {
    const { r } = await run(dov, [
      { toolCalls: [{ name: "create_task", input: { taskName: "x" } }, { name: "record_commitment", input: { toWhom: "לקוח", what: "y" } }] },
      { text: "סיימתי" },
    ]);
    expect(r.form!.kind).toBe("task");
    expect(db.prepare("SELECT COUNT(*) AS n FROM form_requests").get()).toEqual({ n: 1 });
  });

  it("רשימת הכלים: כל ארבעת כלי היצירה הם כלי טופס; רוחמה בלי create_project_stage/create_lead", async () => {
    const dovRun = await run(dov, [{ text: "שלום" }], "שלום");
    const dovTools = Object.fromEntries((dovRun.calls[0]!.tools ?? []).map((t) => [t.name, t.description]));
    expect(dovTools.create_task).toContain("טופס");
    expect(dovTools.record_commitment).toContain("טופס");
    expect(dovTools.create_project_stage).toContain("טופס");
    expect(dovTools.create_lead).toContain("טופס");
    expect(dovRun.calls[0]!.system).toContain("טפסי יצירה");

    const rRun = await run(ruchama, [{ text: "שלום" }], "שלום");
    const names = (rRun.calls[0]!.tools ?? []).map((t) => t.name);
    expect(names).toContain("create_task");
    expect(names).not.toContain("create_project_stage");
    expect(names).not.toContain("create_lead");
  });

  it("בלי אף הרשאת יצירה (גולדי) אין כלי יצירה חוץ מהתחייבות, ואין בלוק טפסים שמזכיר אחרים", async () => {
    const g = await run(goldi, [{ text: "שלום" }], "שלום");
    const names = (g.calls[0]!.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("create_task");
    expect(names).toContain("record_commitment");
  });

  it("היסטוריה וחידוש שיחה: הטופס מוצמד להודעה ונטען עם מצבו העדכני (פתוח → נשלח)", async () => {
    const { r } = await run(dov, [{ toolCalls: [{ name: "record_commitment", input: { toWhom: "לקוח כהן", what: "לשלוח" } }] }, { text: "ok" }]);
    appendChatTurn(dov.key, "s-chat", "הבטחתי ללקוח", r.reply, r.actions, r.form?.id);

    const before = loadChatSession(dov.key, "s-chat");
    const withForm = before.messages.find((m) => m.form);
    expect(withForm?.form).toMatchObject({ id: r.form!.id, status: "open" });

    await submitForm(dov, r.form!.id, { values: r.form!.values }, deps({ appendHistory: (u, s, t) => void db.prepare("INSERT INTO chat_messages (user_key, session_id, role, content) VALUES (?, ?, 'assistant', ?)").run(u, s, t) }));
    const after = loadChatSession(dov.key, "s-chat");
    expect(after.messages.find((m) => m.form)?.form).toMatchObject({ status: "submitted" });
    expect(after.messages[after.messages.length - 1]!.content).toContain("נשמר ביומן");
  });
});

describe("API", () => {
  const call = (user: typeof dov | null, method: string, path: string, body: Record<string, unknown> = {}, query = "", d = {}) =>
    handleFormsRequest({ method, path, query: new URLSearchParams(query), readBody: async () => body, user }, d);

  it("401 בלי משתמש; get רק לבעלים; 404 לאחר", async () => {
    const f = openTask();
    expect((await call(null, "GET", "/api/forms/get", {}, `id=${f.id}`)).status).toBe(401);
    expect((await call(dov, "GET", "/api/forms/get", {}, `id=${f.id}`)).status).toBe(200);
    expect((await call(moti, "GET", "/api/forms/get", {}, `id=${f.id}`)).status).toBe(404);
  });

  it("options: מקור לא מוכר → 400; מקור תקין מחזיר אפשרויות דינמיות", async () => {
    expect((await call(dov, "GET", "/api/forms/options", {}, "source=hack")).status).toBe(400);
    const r = await call(dov, "GET", "/api/forms/options", {}, "source=stages&project=בלומינג", { options: OPTIONS });
    expect(r.body).toEqual({ options: ["שלב 1 - תכנון", "שלב 2 - היתר"] });
    const prod = await call(dov, "GET", "/api/forms/options", {}, "source=lead_product", { options: OPTIONS });
    expect(prod.body).toEqual({ options: ["מעונות יום", "בית ספר", "מקווה"] });
  });

  it("submit: שגיאת ולידציה → 400 עם fieldErrors; הצלחה → 200 עם הטופס והאישור; ביטול → 200", async () => {
    const fake = taskFake();
    const service = deps({ createTaskAction: fake as unknown as typeof createTaskAction });
    const f = openTask(dov, {});
    const bad = await call(dov, "POST", "/api/forms/submit", { id: f.id, values: {} }, "", { service });
    expect(bad.status).toBe(400);
    expect((bad.body as { fieldErrors: unknown }).fieldErrors).toEqual({ taskName: "שדה חובה", scope: "שדה חובה" });
    const ok = await call(dov, "POST", "/api/forms/submit", { id: f.id, values: { taskName: "x", scope: "general" } }, "", { service });
    expect(ok.status).toBe(200);
    expect((ok.body as { form: { status: string } }).form.status).toBe("submitted");

    const g = openTask();
    const c = await call(dov, "POST", "/api/forms/cancel", { id: g.id });
    expect((c.body as { form: { status: string } }).form.status).toBe("cancelled");
  });

  it("כשל ביצירה מוחזר עם הטופס הפתוח והשגיאה", async () => {
    const service = deps({ createTaskAction: vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof createTaskAction });
    const f = openTask();
    const r = await call(dov, "POST", "/api/forms/submit", { id: f.id, values: f.values }, "", { service });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "boom", form: { status: "open", error: "boom" } });
  });
});
