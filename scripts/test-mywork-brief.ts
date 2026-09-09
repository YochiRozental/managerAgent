/**
 * בדיקת getMyWorkBrief / buildBrief — לוגיקה מקומית, בלי Monday (getDashboard מוזרק).
 * מריץ: npm run test:mywork
 */
import { readFileSync } from "node:fs";
import {
  BRIEF_HARD_CAP,
  buildBrief,
  getMyWorkBrief,
  type MyWorkBriefDeps,
} from "../src/ops/myWorkBrief.js";
import type { DashboardTask, EmployeeDashboard } from "../src/ops/dashboard.js";
import type { IdentifiedUser } from "../src/identity/index.js";
import { resolveUserByKey } from "../src/identity/index.js";
import { logger } from "../src/utils/logger.js";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) logger.info(`✅ ${msg}`);
  else {
    failures++;
    logger.error(`❌ ${msg}`);
  }
}

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

// ───────────────────────── buildBrief ─────────────────────────
logger.info("— buildBrief —");
{
  const b = buildBrief("דוב", mkDash({ myDay: [mkTask({ itemId: "1" }), mkTask({ itemId: "2" })] }));
  assert(b.user === "דוב", "user מועבר");
  assert(b.generatedAt === "2026-09-09T08:00:00.000+03:00", "generatedAt מהדשבורד");
  assert(b.tasks.length === 2 && b.summary.inBrief === 2, "2 משימות → 2 ב-brief");
  assert(b.tasks.every((t) => t.bucket === "today"), "כולן bucket=today");
}

// E — cap ל-30, גם עם 100 myDay
{
  const many = Array.from({ length: 100 }, (_, i) => mkTask({ itemId: `m${i}` }));
  const b = buildBrief("X", mkDash({ myDay: many }));
  assert(b.tasks.length === BRIEF_HARD_CAP && BRIEF_HARD_CAP === 30, "E: 100 myDay → בדיוק 30 ב-brief");
  assert(b.summary.today === 100 && b.summary.inBrief === 30, "E: summary מציג 100 להיום, 30 ב-brief");
  assert(!!b.note && b.note.includes("30") && b.note.includes("100"), "E: note מסביר שחתכנו 30 מתוך 100");
}

// E — cap גם דרך opts.limit חורג
{
  const many = Array.from({ length: 50 }, (_, i) => mkTask({ itemId: `k${i}` }));
  const b = buildBrief("X", mkDash({ myDay: many }), 999);
  assert(b.tasks.length === 30, "E: cap=999 עדיין נחתך ל-30");
}

// D — overdue / dueToday מהדגלים
{
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
  assert(od.daysOverdue === 5, "D: daysOverdue=5 מועבר");
  assert(td.dueToday === true, "D: dueToday=true מועבר");
  assert(plain.daysOverdue === undefined && plain.dueToday === undefined, "D: משימה רגילה — בלי שדות איחור");
}

// F — project + stage נשמרים; משימת משרד בלי project
{
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
  assert(p1.project === "פרויקט אלפא" && p1.projectId === "999" && p1.stage === "שלב 3 : בקרת תוכן", "F: project + projectId + stage נשמרים");
  assert(p1.source === "project" && p1.priority === "קריטי ⚠️" && p1.ballWith === "וועדה", "F: source=project, priority, ballWith");
  assert(o1.project === undefined && o1.projectId === undefined && o1.source === "office", "F: משימת משרד — בלי project, source=office");
  assert(b.tasks.find((t) => t.id === "o1")!.ballWith === undefined, "F: 'המשרד'/ריק לא נכנס ל-ballWith");
}

// C — brief מכיל אך ורק פריטים משלוש התצוגות (לא מוסיף כלום)
{
  const inBucket = mkTask({ itemId: "in" });
  const notInAnyBucket = mkTask({ itemId: "ghost", status: "הושלם" });
  void notInAnyBucket; // לא מוכנס לשום דלי — כמו משימה שה-opsRead כבר סינן
  const b = buildBrief("X", mkDash({ myDay: [inBucket], needsAttention: [], waitingOnMe: [] }));
  assert(b.tasks.length === 1 && b.tasks[0]!.id === "in", "C: רק מה שבדליים נכנס; משימה סגורה מחוץ לדליים לא מופיעה");
}

const crit = (o: { itemId: string }) => mkTask({ ...o, flags: { critical: true } as DashboardTask["flags"] });
const stuck = (o: { itemId: string }) => mkTask({ ...o, flags: { stuck: true } as DashboardTask["flags"] });
const blocker = (o: { itemId: string }) =>
  mkTask({ ...o, flags: { blocking: [{ itemId: "x", name: "x", assignees: "", project: "" }] } as DashboardTask["flags"] });

// בחירה — myDay קטן *לא* גורם להוספת כל waitingOnMe
{
  const b = buildBrief(
    "X",
    mkDash({
      myDay: [mkTask({ itemId: "d1" }), mkTask({ itemId: "d2" }), mkTask({ itemId: "d3" })],
      needsAttention: [],
      // כולם "רגילים" — לא critical/stuck/blocking
      waitingOnMe: Array.from({ length: 12 }, (_, i) => mkTask({ itemId: `w${i}` })),
    }),
  );
  assert(b.tasks.length === 3, "בחירה: myDay=3, waitingOnMe=12 רגילים → brief=3 (לא מוצפים)");
  assert(b.summary.waitingOnMe === 12, "בחירה: summary.waitingOnMe מדווח 12 למרות שאף אחד לא נכנס");
  assert(!b.tasks.some((t) => t.bucket === "waiting"), "בחירה: אין פריטי bucket=waiting");
}

// needsAttention שאינו כבר ב-myDay — כן מצורף (חריגה אמיתית, לא "מילוי")
{
  const b = buildBrief(
    "X",
    mkDash({
      myDay: [mkTask({ itemId: "d1" })],
      needsAttention: [stuck({ itemId: "n1" }), mkTask({ itemId: "n2" })],
      waitingOnMe: [],
    }),
  );
  assert(b.tasks.length === 3, "needsAttention: 1 today + 2 attention = 3");
  assert(b.tasks.filter((t) => t.bucket === "attention").map((t) => t.id).sort().join() === "n1,n2", "needsAttention: n1,n2 צורפו כ-attention");
}

// waitingOnMe — רק critical/stuck/blocking שאינם כבר במקום אחר, ולכל היותר 3
{
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
  assert(waiting.length === 3, "waiting: בדיוק 3 (WAITING_EXTRA_MAX), למרות ש-4 עומדים בקריטריון");
  assert(!waiting.includes("plain1") && !waiting.includes("plain2"), "waiting: פריטים רגילים לא נכנסים");
  assert(waiting.every((id) => ["c1", "s1", "b1", "c2"].includes(id)), "waiting: רק critical/stuck/blocking");
}

// waitingOnMe critical שכבר ב-myDay → לא נספר שוב
{
  const shared = crit({ itemId: "shared" });
  const b = buildBrief("X", mkDash({ myDay: [shared], needsAttention: [], waitingOnMe: [shared, crit({ itemId: "other" })] }));
  assert(b.tasks.filter((t) => t.id === "shared").length === 1, "waiting: critical שכבר ב-myDay לא כפול");
  assert(b.tasks.find((t) => t.id === "shared")!.bucket === "today", "waiting: נשמר bucket=today");
  assert(b.tasks.some((t) => t.id === "other" && t.bucket === "waiting"), "waiting: 'other' (critical, לא ב-myDay) כן צורף");
}

// hard cap 30 עדיין נשמר — גם עם needsAttention + waiting ענקיים
{
  const b = buildBrief(
    "X",
    mkDash({
      myDay: Array.from({ length: 25 }, (_, i) => mkTask({ itemId: `m${i}` })),
      needsAttention: Array.from({ length: 20 }, (_, i) => stuck({ itemId: `n${i}` })),
      waitingOnMe: Array.from({ length: 20 }, (_, i) => crit({ itemId: `w${i}` })),
    }),
  );
  assert(b.tasks.length === 30, "cap: 25 myDay + 20 attention + waiting → נחתך ל-30");
  assert(b.tasks.filter((t) => t.bucket === "today").length === 25, "cap: כל 25 ה-myDay נכנסו");
  assert(b.tasks.filter((t) => t.bucket === "attention").length === 5, "cap: רק 5 מ-needsAttention נכנסו (עד המכסה)");
  assert(b.tasks.filter((t) => t.bucket === "waiting").length === 0, "cap: waiting לא הגיע — המכסה נגמרה");
}

// dedup — אותו id בשני דליים → פעם אחת, bucket=today
{
  const shared = mkTask({ itemId: "shared" });
  const b = buildBrief("X", mkDash({ myDay: [shared], needsAttention: [shared, mkTask({ itemId: "x" })] }));
  assert(b.tasks.filter((t) => t.id === "shared").length === 1, "dedup: 'shared' פעם אחת");
  assert(b.tasks.find((t) => t.id === "shared")!.bucket === "today", "dedup: נשמר bucket=today (הראשון)");
  assert(b.tasks.some((t) => t.id === "x" && t.bucket === "attention"), "dedup: 'x' (needsAttention לא-כפול) כן צורף");
}

// ───────────────────────── getMyWorkBrief ─────────────────────────
logger.info("— getMyWorkBrief —");

// G — אין mondayUserId → שגיאה ברורה, ולא נקרא getDashboard
{
  let called = 0;
  const deps: MyWorkBriefDeps = {
    getDashboard: async () => {
      called++;
      return mkDash({ myDay: [] });
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
  let threw = false;
  try {
    await getMyWorkBrief(noMonday, {}, deps);
  } catch (e) {
    threw = (e as Error).message.includes("Monday");
  }
  assert(threw, "G: משתמש בלי mondayUserId → שגיאה שמזכירה Monday");
  assert(called === 0, "G: getDashboard לא נקרא כשאין mondayUserId (אין דליפה / אין fallback)");
}

// A — בידוד: getDashboard מקבל את המשתמש שנשלח, ומחזיר רק את המשימות שלו
{
  const dov = resolveUserByKey("dov")!;
  const received: string[] = [];
  const deps: MyWorkBriefDeps = {
    getDashboard: async (u) => {
      received.push(u.key);
      // מדמה fetchUserOpsTasks(u.mondayUserId): משימות שונות לכל משתמש
      const id = u.key === "dov" ? "DOV-1" : "EITAN-1";
      return mkDash({ myDay: [mkTask({ itemId: id, assignees: u.name })], user: { key: u.key, name: u.name, role: u.role } });
    },
  };
  const b = await getMyWorkBrief(dov, {}, deps);
  assert(received.length === 1 && received[0] === "dov", "A: getDashboard נקרא עם dov (identity זורם)");
  assert(b.tasks.length === 1 && b.tasks[0]!.id === "DOV-1", "A: dov מקבל רק את המשימות של dov");
  assert(!b.tasks.some((t) => t.id === "EITAN-1"), "A: dov לא מקבל את המשימות של eitan");
  assert(b.user === "דוב שפירא", "A: שם המשתמש ב-brief הוא של dov");
}

// ───────────────────────── B — אין assigned_to_me / listMyWork בקוד (לא בהערות) ─────────────────────────
logger.info("— אין assigned_to_me / listMyWork בקוד —");
{
  // מסירים הערות כדי לבדוק קוד ממשי בלבד (התיעוד מזכיר את השמות הישנים בכוונה)
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const brief = stripComments(readFileSync(new URL("../src/ops/myWorkBrief.ts", import.meta.url), "utf8"));
  const tools = stripComments(readFileSync(new URL("../src/integrations/claude/tools.ts", import.meta.url), "utf8"));
  const tasks = stripComments(readFileSync(new URL("../src/integrations/monday/tasks.ts", import.meta.url), "utf8"));
  assert(!/assigned_to_me/.test(brief + tools + tasks), "B: אין 'assigned_to_me' בקוד של myWorkBrief / tools / tasks");
  assert(!/\blistMyWork\b/.test(tasks + tools), "B: אין קריאה/הגדרה של listMyWork בקוד");
  assert(!/\bMyWorkItem\b/.test(tasks + tools), "B: MyWorkItem הוסר מהקוד");
  assert(/getMyWorkBrief\(ctx\.user\)/.test(tools), "B: הכלי list_my_work קורא ל-getMyWorkBrief(ctx.user)");
}

// ───────────────────────── I — scope monday ב-test-ai-compare = read only ─────────────────────────
logger.info("— test-ai-compare monday scope —");
{
  const cmp = readFileSync(new URL("./test-ai-compare.ts", import.meta.url), "utf8");
  // הענף של scope monday מייבא רק ממודולי קריאה
  const mondayBranch = cmp.slice(cmp.indexOf('scope === "monday" || scope === "all"'), cmp.indexOf('scope === "google"'));
  assert(!/opsWrite|itemWrite|\/leads\.js|ops\/actions|change_column_value|create_item|delete_item/.test(mondayBranch), "I: ענף monday לא מייבא/קורא שום פונקציית כתיבה");
  assert(/getMyWorkBrief\(user\)/.test(mondayBranch) && /assigned_to_me/.test(mondayBranch), "I: list_my_work דורש user מפורש, בלי fallback ל-assigned_to_me");
}

logger.info("");
if (failures > 0) {
  logger.error(`${failures} בדיקות נכשלו ❌`);
  process.exit(1);
}
logger.info("כל בדיקות ה-brief עברו ✅");
