/**
 * getMyWorkBrief / buildBrief — הועבר אחד-לאחד מ-scripts/test-mywork-brief.ts (59 בדיקות,
 * הסקריפט הישן הוסר). getDashboard/getFeed מוזרקים — אין Monday. קבצי מקור נקראים לקריאה בלבד.
 */

import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { BRIEF_HARD_CAP, buildBrief, getMyWorkBrief, type MyWorkBriefDeps } from "../../src/ops/myWorkBrief.js";
import type { DashboardTask, EmployeeDashboard } from "../../src/ops/dashboard.js";
import type { EmployeeFeed } from "../../src/ops/employeeFeed.js";
import type { IdentifiedUser } from "../../src/identity/index.js";
import { resolveUserByKey } from "../../src/identity/index.js";

// ───────────────────────── fixtures ─────────────────────────
function mkTask(o: Partial<DashboardTask> & { itemId: string }): DashboardTask {
  return {
    source: "general",
    name: `task-${o.itemId}`,
    url: `https://x/${o.itemId}`,
    context: "משימת משרד",
    status: "לביצוע",
    assignees: "מוטי",
    ...o,
    flags: {
      overdue: false,
      daysOverdue: 0,
      dueToday: false,
      dueThisWeek: false,
      stuck: false,
      critical: false,
      waitingExternal: false,
      blocking: [],
      ...(o.flags ?? {}),
    },
  };
}

function mkFeed(o: Partial<EmployeeFeed> = {}): EmployeeFeed {
  const empty = { ok: true as const, items: [] };
  return { newLeads: empty, newDeals: empty, dealsNeedingAttention: empty, tasks: empty, projectTasks: empty, ...o };
}

function mkDash(o: Partial<EmployeeDashboard> & { myDay: DashboardTask[] }): EmployeeDashboard {
  const needsAttention = o.needsAttention ?? [];
  const waitingOnMe = o.waitingOnMe ?? [];
  return {
    user: { key: "u", name: o.user?.name ?? "בדיקה", role: "planner" },
    generatedAt: "2026-09-09T08:00:00.000+03:00",
    myDay: o.myDay,
    needsAttention,
    waitingOnMe,
    counts: o.counts ?? {
      myDay: o.myDay.length,
      needsAttention: needsAttention.length,
      waitingOnMe: waitingOnMe.length,
      totalOpen: o.myDay.length + needsAttention.length + waitingOnMe.length,
    },
  };
}

const crit = (o: { itemId: string }) => mkTask({ ...o, flags: { critical: true } as DashboardTask["flags"] });
const stuck = (o: { itemId: string }) => mkTask({ ...o, flags: { stuck: true } as DashboardTask["flags"] });
const blocker = (o: { itemId: string }) =>
  mkTask({ ...o, flags: { blocking: [{ itemId: "x", name: "x", assignees: "", project: "" }] } as DashboardTask["flags"] });

// ───────────────────────── buildBrief ─────────────────────────
describe("buildBrief — בסיס", () => {
  const b = buildBrief("דוב", mkDash({ myDay: [mkTask({ itemId: "1" }), mkTask({ itemId: "2" })] }));
  it("user מועבר", () => expect(b.user).toBe("דוב"));
  it("generatedAt מהדשבורד", () => expect(b.generatedAt).toBe("2026-09-09T08:00:00.000+03:00"));
  it("2 משימות → 2 ב-brief", () => {
    expect(b.tasks).toHaveLength(2);
    expect(b.summary.inBrief).toBe(2);
  });
  it("כולן bucket=today", () => expect(b.tasks.every((t) => t.bucket === "today")).toBe(true));
});

describe("E — cap ל-30", () => {
  const many = Array.from({ length: 100 }, (_, i) => mkTask({ itemId: `m${i}` }));
  const b = buildBrief("X", mkDash({ myDay: many }));
  it("E: 100 myDay → בדיוק 30 ב-brief", () => {
    expect(b.tasks).toHaveLength(BRIEF_HARD_CAP);
    expect(BRIEF_HARD_CAP).toBe(30);
  });
  it("E: summary מציג 100 להיום, 30 ב-brief", () => {
    expect(b.summary.today).toBe(100);
    expect(b.summary.inBrief).toBe(30);
  });
  it("E: note מסביר שחתכנו 30 מתוך 100", () => {
    expect(b.note).toBeTruthy();
    expect(b.note).toContain("30");
    expect(b.note).toContain("100");
  });
  it("E: cap=999 עדיין נחתך ל-30", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => mkTask({ itemId: `k${i}` }));
    expect(buildBrief("X", mkDash({ myDay: fifty }), 999).tasks).toHaveLength(30);
  });
});

describe("D — overdue / dueToday מהדגלים", () => {
  const b = buildBrief(
    "X",
    mkDash({
      myDay: [
        mkTask({ itemId: "od", flags: { overdue: true, daysOverdue: 5 } as DashboardTask["flags"] }),
        mkTask({ itemId: "td", flags: { dueToday: true } as DashboardTask["flags"] }),
        mkTask({ itemId: "plain" }),
      ],
    }),
  );
  const od = b.tasks.find((t) => t.id === "od")!;
  const td = b.tasks.find((t) => t.id === "td")!;
  const plain = b.tasks.find((t) => t.id === "plain")!;
  it("D: daysOverdue=5 מועבר", () => expect(od.daysOverdue).toBe(5));
  it("D: dueToday=true מועבר", () => expect(td.dueToday).toBe(true));
  it("D: משימה רגילה — בלי שדות איחור", () => {
    expect(plain.daysOverdue).toBeUndefined();
    expect(plain.dueToday).toBeUndefined();
  });
});

describe("F — project + stage", () => {
  const b = buildBrief(
    "X",
    mkDash({
      myDay: [
        mkTask({
          itemId: "p1",
          source: "project_stage",
          context: "פרויקט אלפא",
          projectId: "999",
          stageName: "שלב 3 : בקרת תוכן",
          priority: "קריטי ⚠️",
          responsibleParty: "וועדה",
        }),
        mkTask({ itemId: "o1", source: "general", context: "משימת משרד" }),
      ],
    }),
  );
  const p1 = b.tasks.find((t) => t.id === "p1")!;
  const o1 = b.tasks.find((t) => t.id === "o1")!;
  it("F: project + projectId + stage נשמרים", () => {
    expect(p1.project).toBe("פרויקט אלפא");
    expect(p1.projectId).toBe("999");
    expect(p1.stage).toBe("שלב 3 : בקרת תוכן");
  });
  it("F: source=project, priority, ballWith", () => {
    expect(p1.source).toBe("project");
    expect(p1.priority).toBe("קריטי ⚠️");
    expect(p1.ballWith).toBe("וועדה");
  });
  it("F: משימת משרד — בלי project, source=office", () => {
    expect(o1.project).toBeUndefined();
    expect(o1.projectId).toBeUndefined();
    expect(o1.source).toBe("office");
  });
  it("F: 'המשרד'/ריק לא נכנס ל-ballWith", () => expect(o1.ballWith).toBeUndefined());
});

describe("C — רק מה שבדליים", () => {
  it("C: רק מה שבדליים נכנס; משימה סגורה מחוץ לדליים לא מופיעה", () => {
    const b = buildBrief("X", mkDash({ myDay: [mkTask({ itemId: "in" })], needsAttention: [], waitingOnMe: [] }));
    expect(b.tasks).toHaveLength(1);
    expect(b.tasks[0]!.id).toBe("in");
  });
});

describe("בחירה — myDay קטן לא מוסיף את כל waitingOnMe", () => {
  const b = buildBrief(
    "X",
    mkDash({
      myDay: [mkTask({ itemId: "d1" }), mkTask({ itemId: "d2" }), mkTask({ itemId: "d3" })],
      needsAttention: [],
      waitingOnMe: Array.from({ length: 12 }, (_, i) => mkTask({ itemId: `w${i}` })),
    }),
  );
  it("בחירה: myDay=3, waitingOnMe=12 רגילים → brief=3 (לא מוצפים)", () => expect(b.tasks).toHaveLength(3));
  it("בחירה: summary.waitingOnMe מדווח 12 למרות שאף אחד לא נכנס", () => expect(b.summary.waitingOnMe).toBe(12));
  it("בחירה: אין פריטי bucket=waiting", () => expect(b.tasks.some((t) => t.bucket === "waiting")).toBe(false));
});

describe("needsAttention שאינו כבר ב-myDay", () => {
  const b = buildBrief(
    "X",
    mkDash({ myDay: [mkTask({ itemId: "d1" })], needsAttention: [stuck({ itemId: "n1" }), mkTask({ itemId: "n2" })], waitingOnMe: [] }),
  );
  it("needsAttention: 1 today + 2 attention = 3", () => expect(b.tasks).toHaveLength(3));
  it("needsAttention: n1,n2 צורפו כ-attention", () =>
    expect(b.tasks.filter((t) => t.bucket === "attention").map((t) => t.id).sort().join()).toBe("n1,n2"));
});

describe("waitingOnMe — רק critical/stuck/blocking, עד 3", () => {
  const b = buildBrief(
    "X",
    mkDash({
      myDay: [mkTask({ itemId: "d1" })],
      needsAttention: [],
      waitingOnMe: [
        mkTask({ itemId: "plain1" }),
        crit({ itemId: "c1" }),
        stuck({ itemId: "s1" }),
        blocker({ itemId: "b1" }),
        crit({ itemId: "c2" }),
        mkTask({ itemId: "plain2" }),
      ],
    }),
  );
  const waiting = b.tasks.filter((t) => t.bucket === "waiting").map((t) => t.id);
  it("waiting: בדיוק 3 (WAITING_EXTRA_MAX), למרות ש-4 עומדים בקריטריון", () => expect(waiting).toHaveLength(3));
  it("waiting: פריטים רגילים לא נכנסים", () => {
    expect(waiting).not.toContain("plain1");
    expect(waiting).not.toContain("plain2");
  });
  it("waiting: רק critical/stuck/blocking", () =>
    expect(waiting.every((id) => ["c1", "s1", "b1", "c2"].includes(id))).toBe(true));
});

describe("waitingOnMe critical שכבר ב-myDay", () => {
  const shared = crit({ itemId: "shared" });
  const b = buildBrief("X", mkDash({ myDay: [shared], needsAttention: [], waitingOnMe: [shared, crit({ itemId: "other" })] }));
  it("waiting: critical שכבר ב-myDay לא כפול", () => expect(b.tasks.filter((t) => t.id === "shared")).toHaveLength(1));
  it("waiting: נשמר bucket=today", () => expect(b.tasks.find((t) => t.id === "shared")!.bucket).toBe("today"));
  it("waiting: 'other' (critical, לא ב-myDay) כן צורף", () =>
    expect(b.tasks.some((t) => t.id === "other" && t.bucket === "waiting")).toBe(true));
});

describe("hard cap 30 עם דליים ענקיים", () => {
  const b = buildBrief(
    "X",
    mkDash({
      myDay: Array.from({ length: 25 }, (_, i) => mkTask({ itemId: `m${i}` })),
      needsAttention: Array.from({ length: 20 }, (_, i) => stuck({ itemId: `n${i}` })),
      waitingOnMe: Array.from({ length: 20 }, (_, i) => crit({ itemId: `w${i}` })),
    }),
  );
  it("cap: 25 myDay + 20 attention + waiting → נחתך ל-30", () => expect(b.tasks).toHaveLength(30));
  it("cap: כל 25 ה-myDay נכנסו", () => expect(b.tasks.filter((t) => t.bucket === "today")).toHaveLength(25));
  it("cap: רק 5 מ-needsAttention נכנסו (עד המכסה)", () => expect(b.tasks.filter((t) => t.bucket === "attention")).toHaveLength(5));
  it("cap: waiting לא הגיע — המכסה נגמרה", () => expect(b.tasks.filter((t) => t.bucket === "waiting")).toHaveLength(0));
});

describe("dedup — אותו id בשני דליים", () => {
  const shared = mkTask({ itemId: "shared" });
  const b = buildBrief("X", mkDash({ myDay: [shared], needsAttention: [shared, mkTask({ itemId: "x" })] }));
  it("dedup: 'shared' פעם אחת", () => expect(b.tasks.filter((t) => t.id === "shared")).toHaveLength(1));
  it("dedup: נשמר bucket=today (הראשון)", () => expect(b.tasks.find((t) => t.id === "shared")!.bucket).toBe("today"));
  it("dedup: 'x' (needsAttention לא-כפול) כן צורף", () =>
    expect(b.tasks.some((t) => t.id === "x" && t.bucket === "attention")).toBe(true));
});

// ───────────────────────── getMyWorkBrief ─────────────────────────
describe("G — אין mondayUserId", () => {
  let called = 0;
  let feedCalled = 0;
  const deps: MyWorkBriefDeps = {
    getDashboard: async () => {
      called++;
      return mkDash({ myDay: [] });
    },
    getFeed: async () => {
      feedCalled++;
      return mkFeed();
    },
  };
  const noMonday: IdentifiedUser = {
    key: "goldi",
    name: "גולדי",
    role: "finance",
    mondayUserId: null,
    email: null,
    whatsappJid: null,
    permissions: ["view:own_work"],
    roleDescription: "",
  };
  const run = getMyWorkBrief(noMonday, {}, deps).then(
    () => false,
    (e: Error) => e.message.includes("Monday"),
  );

  it("G: משתמש בלי mondayUserId → שגיאה שמזכירה Monday", async () => expect(await run).toBe(true));
  it("G: getDashboard לא נקרא כשאין mondayUserId (אין דליפה / אין fallback)", async () => {
    await run;
    expect(called).toBe(0);
  });
  it("G: getFeed לא נקרא כשאין mondayUserId", async () => {
    await run;
    expect(feedCalled).toBe(0);
  });
});

describe("A — בידוד: כל משתמש מקבל רק את שלו", () => {
  const dov = resolveUserByKey("dov")!;
  const received: string[] = [];
  const receivedFeedIds: string[] = [];
  const deps: MyWorkBriefDeps = {
    getDashboard: async (u) => {
      received.push(u.key);
      const id = u.key === "dov" ? "DOV-1" : "EITAN-1";
      return mkDash({ myDay: [mkTask({ itemId: id, assignees: u.name })], user: { key: u.key, name: u.name, role: u.role } });
    },
    getFeed: async (mondayUserId) => {
      receivedFeedIds.push(mondayUserId);
      return mkFeed();
    },
  };
  const run = getMyWorkBrief(dov, {}, deps);

  it("A: getDashboard נקרא עם dov (identity זורם)", async () => {
    await run;
    expect(received).toEqual(["dov"]);
  });
  it("A: dov מקבל רק את המשימות של dov", async () => {
    const b = await run;
    expect(b.tasks).toHaveLength(1);
    expect(b.tasks[0]!.id).toBe("DOV-1");
  });
  it("A: dov לא מקבל את המשימות של eitan", async () => expect((await run).tasks.some((t) => t.id === "EITAN-1")).toBe(false));
  it("A: שם המשתמש ב-brief הוא של dov", async () => expect((await run).user).toBe("דוב שפירא"));
  it("A: getFeed נקרא עם mondayUserId של dov, לא של משתמש אחר", async () => {
    await run;
    expect(receivedFeedIds).toEqual([dov.mondayUserId]);
  });
});

describe("H — pipelineText", () => {
  const dov = resolveUserByKey("dov")!;
  const morning = DateTime.fromISO("2026-10-13T08:00:00", { zone: "Asia/Jerusalem" });
  const run = getMyWorkBrief(dov, {}, { getDashboard: async () => mkDash({ myDay: [] }), getFeed: async () => mkFeed(), now: morning });
  const runWithError = getMyWorkBrief(dov, {}, {
    getDashboard: async () => mkDash({ myDay: [] }),
    getFeed: async () => mkFeed({ tasks: { ok: false, error: "בדיקה: שליפה נכשלה" } }),
  });

  it("H: pipelineText קיים ולא ריק", async () => {
    const t = (await run).pipelineText;
    expect(typeof t).toBe("string");
    expect(t!.length).toBeGreaterThan(0);
  });
  for (const label of ["לידים חדשים", "עסקאות חדשות", "עסקאות לטיפול", "משימות רגילות", "משימות פרויקטים"]) {
    it(`H: pipelineText מכיל את הכותרת "${label}" גם כשהכול ריק`, async () => expect((await run).pipelineText).toContain(label));
  }
  it("H: קטגוריה ריקה מוצגת כ'אין פריטים כרגע', לא מוסתרת", async () =>
    expect((await run).pipelineText).toContain("אין פריטים כרגע"));
  it("H: pipelineText כולל ברכה+שם וכותרת ראשית (formatEmployeeFeedBriefing) — תצוגה אחת, לא תדריך ישן+חדש", async () =>
    expect((await run).pipelineText!.startsWith("בוקר טוב, דוב שפירא ☀️\nסדר העבודה שלך להיום")).toBe(true));
  it("H: WhatsApp — הדגשה בכוכבית בודדת, לא כפולה כמו בחלונית", async () => {
    const t = (await run).pipelineText!;
    expect(t).toMatch(/\*[^*]+\*/);
    expect(t).not.toContain("**");
  });
  it("H: כשל שליפה בקטגוריה אחת מוצג כשגיאה מפורשת, לא מוסתר כריק", async () =>
    expect((await runWithError).pipelineText).toContain("בדיקה: שליפה נכשלה"));
  it("H: שאר הכותרות עדיין מופיעות כשקטגוריה אחת נכשלה", async () => {
    const t = (await runWithError).pipelineText!;
    expect(t).toContain("לידים חדשים");
    expect(t).toContain("משימות פרויקטים");
  });
});

// ───────────────────────── B — אין assigned_to_me / listMyWork בקוד (לא בהערות) ─────────────────────────
describe("B — אין assigned_to_me / listMyWork בקוד", () => {
  // מסירים הערות כדי לבדוק קוד ממשי בלבד (התיעוד מזכיר את השמות הישנים בכוונה)
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
  const brief = read("../../src/ops/myWorkBrief.ts");
  const tools = read("../../src/integrations/claude/tools.ts");
  const tasks = read("../../src/integrations/monday/tasks.ts");

  it("B: אין 'assigned_to_me' בקוד של myWorkBrief / tools / tasks", () => expect(brief + tools + tasks).not.toMatch(/assigned_to_me/));
  it("B: אין קריאה/הגדרה של listMyWork בקוד", () => expect(tasks + tools).not.toMatch(/\blistMyWork\b/));
  it("B: MyWorkItem הוסר מהקוד", () => expect(tasks + tools).not.toMatch(/\bMyWorkItem\b/));
  it("B: הכלי list_my_work קורא ל-getMyWorkBrief(ctx.user)", () => expect(tools).toMatch(/getMyWorkBrief\(ctx\.user\)/));
});

// ───────────────────────── I — scope monday ב-test-ai-compare = read only ─────────────────────────
describe("I — test-ai-compare monday scope", () => {
  const cmp = readFileSync(new URL("../../scripts/live/test-ai-compare.ts", import.meta.url), "utf8");
  const mondayBranch = cmp.slice(cmp.indexOf('scope === "monday" || scope === "all"'), cmp.indexOf('scope === "google"'));
  it("I: ענף monday לא מייבא/קורא שום פונקציית כתיבה", () =>
    expect(mondayBranch).not.toMatch(/opsWrite|itemWrite|\/leads\.js|ops\/actions|change_column_value|create_item|delete_item/));
  it("I: list_my_work דורש user מפורש, בלי fallback ל-assigned_to_me", () => {
    expect(mondayBranch).toMatch(/getMyWorkBrief\(user\)/);
    expect(mondayBranch).toMatch(/assigned_to_me/);
  });
});
