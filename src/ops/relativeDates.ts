/**
 * פענוח תאריכים יחסיים בעברית (ובאנגלית בסיסית) — לסינון ולעדכון קבוצתי (bulkQuery/bulkUpdate).
 *
 * טהור לגמרי: מקבל "עכשיו" מוזרק (DateTime באזור הזמן של המשרד) ומחזיר טווח ימים YYYY-MM-DD.
 * לא מנחש: ביטוי שלא זוהה (למשל "אחרי החג" — אין כאן לוח חגים) → null, והקורא מחזיר שגיאה
 * שמבקשת מהמודל לשאול את המשתמש לתאריך מדויק.
 *
 * מוסכמות (CLAUDE.md §8 — שבוע עבודה א׳–ה׳, Asia/Jerusalem):
 *  - שבוע = ראשון עד שבת. "השבוע" = הראשון האחרון (כולל היום) עד השבת שאחריו.
 *  - "יום ראשון" / "ראשון הבא" / "ביום ראשון" = המופע הבא *אחרי* היום (אם היום ראשון → בעוד 7 ימים).
 *  - "ראשון שעבר" = המופע האחרון *לפני* היום.
 */

import { DateTime } from "luxon";

export interface DateRange {
  /** YYYY-MM-DD, כולל */
  from: string;
  /** YYYY-MM-DD, כולל */
  to: string;
}

const ISO = "yyyy-MM-dd";

/** luxon: weekday 1=שני ... 7=ראשון. */
const WEEKDAYS: { re: RegExp; luxon: number }[] = [
  { re: /^(יום\s+)?(ראשון|א['׳]?)$|^sun(day)?$/i, luxon: 7 },
  { re: /^(יום\s+)?(שני|ב['׳]?)$|^mon(day)?$/i, luxon: 1 },
  { re: /^(יום\s+)?(שלישי|ג['׳]?)$|^tue(sday)?$/i, luxon: 2 },
  { re: /^(יום\s+)?(רביעי|ד['׳]?)$|^wed(nesday)?$/i, luxon: 3 },
  { re: /^(יום\s+)?(חמישי|ה['׳]?)$|^thu(rsday)?$/i, luxon: 4 },
  { re: /^(יום\s+)?(שישי|ו['׳]?)$|^fri(day)?$/i, luxon: 5 },
  { re: /^(יום\s+)?(שבת)$|^sat(urday)?$/i, luxon: 6 },
];

function day(d: DateTime): DateRange {
  const s = d.toFormat(ISO);
  return { from: s, to: s };
}

function range(a: DateTime, b: DateTime): DateRange {
  return { from: a.toFormat(ISO), to: b.toFormat(ISO) };
}

/** ראשון של השבוע שבו נמצא d (ראשון–שבת). */
function weekStart(d: DateTime): DateTime {
  const back = d.weekday % 7; // ראשון(7)→0, שני(1)→1 ... שבת(6)→6
  return d.minus({ days: back }).startOf("day");
}

function nextWeekday(today: DateTime, luxonWeekday: number): DateTime {
  let diff = (luxonWeekday - today.weekday + 7) % 7;
  if (diff === 0) diff = 7;
  return today.plus({ days: diff });
}

function prevWeekday(today: DateTime, luxonWeekday: number): DateTime {
  let diff = (today.weekday - luxonWeekday + 7) % 7;
  if (diff === 0) diff = 7;
  return today.minus({ days: diff });
}

function normalize(expr: string): string {
  return expr
    .trim()
    .toLowerCase()
    .replace(/[״"]/g, "")
    .replace(/^(ב|ל|עד\s+|מ)(?=(היום|מחר|מחרתיים|אתמול|שלשום|יום|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|שבוע|חודש))/, "")
    .replace(/\s+/g, " ");
}

/** תאריך מפורש: YYYY-MM-DD / DD/MM / DD/MM/YYYY / DD.MM(.YY). שנה חסרה → השנה הנוכחית. */
function parseExplicit(s: string, today: DateTime): DateTime | null {
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = DateTime.fromObject({ year: +iso[1]!, month: +iso[2]!, day: +iso[3]! }, { zone: today.zone });
    return d.isValid ? d : null;
  }
  const dm = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/);
  if (dm) {
    let year = dm[3] ? +dm[3] : today.year;
    if (year < 100) year += 2000;
    const d = DateTime.fromObject({ year, month: +dm[2]!, day: +dm[1]! }, { zone: today.zone });
    return d.isValid ? d : null;
  }
  return null;
}

/**
 * ממיר ביטוי תאריך לטווח ימים. now — באזור הזמן של המשרד (הקורא אחראי: DateTime.now().setZone(env.TIMEZONE)).
 * null = לא זוהה — לעולם לא ניחוש.
 */
export function resolveDateExpr(expr: string, now: DateTime): DateRange | null {
  if (!expr || !expr.trim()) return null;
  const today = now.startOf("day");
  const s = normalize(expr);

  const explicit = parseExplicit(s, today);
  if (explicit) return day(explicit);

  switch (s) {
    case "היום":
    case "today":
      return day(today);
    case "מחר":
    case "tomorrow":
      return day(today.plus({ days: 1 }));
    case "מחרתיים":
      return day(today.plus({ days: 2 }));
    case "אתמול":
    case "yesterday":
      return day(today.minus({ days: 1 }));
    case "שלשום":
      return day(today.minus({ days: 2 }));
    case "השבוע":
    case "שבוע הזה":
    case "this week":
    case "this_week":
      return range(weekStart(today), weekStart(today).plus({ days: 6 }));
    case "שבוע הבא":
    case "בשבוע הבא":
    case "next week":
    case "next_week":
      return range(weekStart(today).plus({ days: 7 }), weekStart(today).plus({ days: 13 }));
    case "שבוע שעבר":
    case "בשבוע שעבר":
    case "last week":
    case "last_week":
      return range(weekStart(today).minus({ days: 7 }), weekStart(today).minus({ days: 1 }));
    case "החודש":
    case "this month":
    case "this_month":
      return range(today.startOf("month"), today.endOf("month").startOf("day"));
    case "חודש הבא":
    case "בחודש הבא":
    case "next month":
    case "next_month": {
      const m = today.plus({ months: 1 });
      return range(m.startOf("month"), m.endOf("month").startOf("day"));
    }
    case "חודש שעבר":
    case "last month":
    case "last_month": {
      const m = today.minus({ months: 1 });
      return range(m.startOf("month"), m.endOf("month").startOf("day"));
    }
  }

  // "בעוד N ימים" / "+N" / "לפני N ימים" / "-N"
  const inDays = s.match(/^(?:בעוד|עוד|in)\s+(\d{1,3})\s*(?:ימים|יום|days?)$/) ?? s.match(/^\+(\d{1,3})d?$/);
  if (inDays) return day(today.plus({ days: +inDays[1]! }));
  const agoDays = s.match(/^(?:לפני)\s+(\d{1,3})\s*(?:ימים|יום)$|^(\d{1,3})\s*days?\s+ago$/) ?? s.match(/^-(\d{1,3})d?$/);
  if (agoDays) return day(today.minus({ days: +(agoDays[1] ?? agoDays[2])! }));
  if (/^(?:בעוד|עוד)\s+שבוע$|^in a week$/.test(s)) return day(today.plus({ days: 7 }));

  // יום בשבוע: "ראשון", "יום ראשון", "ראשון הבא", "יום ראשון הבא", "ראשון שעבר", "next sunday"
  let wd = s;
  let direction: "next" | "prev" = "next";
  const mNext = wd.match(/^(.*?)\s+(הבא|הקרוב)$/) ?? wd.match(/^next\s+(.*)$/);
  const mPrev = wd.match(/^(.*?)\s+(שעבר|האחרון)$/) ?? wd.match(/^last\s+(.*)$/);
  if (mPrev) {
    wd = mPrev[1]!;
    direction = "prev";
  } else if (mNext) {
    wd = mNext[1]!;
  }
  wd = wd.replace(/^ב(?=יום|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/, "");
  const hit = WEEKDAYS.find((w) => w.re.test(wd));
  if (hit) return day(direction === "next" ? nextWeekday(today, hit.luxon) : prevWeekday(today, hit.luxon));

  return null;
}

/** כמו resolveDateExpr, אבל דורש יום יחיד (ליעד עדכון — "העבר ל..."). טווח/לא זוהה → null. */
export function resolveSingleDay(expr: string, now: DateTime): string | null {
  const r = resolveDateExpr(expr, now);
  if (!r || r.from !== r.to) return null;
  return r.from;
}

/** מזיז תאריך YYYY-MM-DD ב-N ימים (שלילי = אחורה). */
export function shiftIsoDate(iso: string, days: number): string {
  return DateTime.fromISO(iso).plus({ days }).toFormat(ISO);
}

const DAY_WORDS = "ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת";
/** ביטויי יום בטקסט חופשי — רק צורות חד-משמעיות ("יום ראשון", "לראשון", "ראשון הבא"), לא "הראשונה ברשימה". */
const DAY_PHRASES: RegExp[] = [
  new RegExp(String.raw`(?:^|\s)(?:[לב])?יום\s+(?:${DAY_WORDS})(?:\s+(?:הבא|הקרוב|שעבר))?(?=$|[\s.,!?])`, "g"),
  new RegExp(String.raw`(?:^|\s)[לב](?:${DAY_WORDS})(?:\s+(?:הבא|הקרוב))?(?=$|[\s.,!?])`, "g"),
  new RegExp(String.raw`(?:^|\s)(?:${DAY_WORDS})\s+(?:הבא|הקרוב|שעבר)(?=$|[\s.,!?])`, "g"),
  /(?:^|\s)[לבו]?(?:מחרתיים|מחר|היום)(?=$|[\s.,!?])/g,
  /(?:^|\s)בעוד\s+\d{1,3}\s+ימים(?=$|[\s.,!?])/g,
];

/**
 * היום היחיד שהמשתמש ציין בטקסט חופשי (למשל "תעביר את כולן ליום ראשון הבא"), או null אם אין
 * ביטוי כזה / יש כמה שונים. משמש לאימות: נמצא בבדיקה חיה (2026-10-21) שמודל FAST "חישב" בעצמו
 * 26/10 במקום יום ראשון 25/10 — לכן הקוד בודק שהתאריך שהמודל העביר תואם את מה שנאמר.
 */
export function explicitDayInText(text: string, now: DateTime): string | null {
  const found = new Set<string>();
  for (const re of DAY_PHRASES) {
    for (const m of text.matchAll(re)) {
      const day = resolveSingleDay(m[0].trim().replace(/^[לבו](?=(יום|מחר|היום|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))/, ""), now);
      if (day) found.add(day);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

const RANGE_PHRASES: RegExp[] = [
  /(?:^|\s)[לב]?(?:השבוע|שבוע הבא|שבוע שעבר|החודש|חודש הבא)(?=$|[\s.,!?])/g,
  /(?:^|\s)[לב]?-?(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)(?=$|[\s.,!?])/g,
];

/**
 * האם המשתמש ציין בטקסט תאריך/טווח שאינו "היום" ("למחר", "ביום ראשון", "שבוע הבא", "25/10").
 * משמש בצ'אט כדי שסיכום היום (get_today_tasks/get_my_pipeline) לא יוגש כתשובה לבקשה על יום אחר —
 * באג production 2026-10-21: "תביא לי את כל מה שיש לי למחר" קיבל את סיכום היום, פעמיים.
 */
export function mentionsNonTodayDate(text: string, now: DateTime): boolean {
  const today = now.toFormat(ISO);
  const exprs: string[] = [];
  for (const re of [...DAY_PHRASES, ...RANGE_PHRASES]) {
    for (const m of text.matchAll(re)) exprs.push((m[1] ?? m[0]).trim().replace(/^[לבו]-?(?=(יום|מחר|היום|השבוע|שבוע|החודש|חודש|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|\d))/, ""));
  }
  return exprs.some((e) => {
    const r = resolveDateExpr(e, now);
    return !!r && !(r.from === today && r.to === today);
  });
}
