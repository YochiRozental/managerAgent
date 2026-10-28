/**
 * פנייה לעובד דרך הסוכן (Web Chat בלבד) — לוגיקת prepare / confirm / cancel מעל agent_outreach
 * (db/repositories/agentOutreach.ts) ומסלול השליחה המשותף (ops/teamDelivery.ts).
 *
 * עקרונות:
 *  • הכנה לא שולחת כלום. שליחה רק אחרי אישור מפורש בהודעה נפרדת — אותה בדיקה דטרמיניסטית שכבר קיימת
 *    בעדכון הקבוצתי (isExplicitConfirmation, createdTurn ≠ ההודעה הנוכחית), לא מנגנון מקביל.
 *  • confirm לא מקבל נוסח מהמודל: נשלח בדיוק מה ש-prepare שמר (agent_outreach.body). שינוי נוסח/נמען =
 *    prepare חדש (הקודם מבוטל) ואישור חדש.
 *  • אידמפוטנטיות: CAS draft→sending, ושליחה עם clientMessageId קבוע `ao:<id>` — שליחה חוזרת מחזירה
 *    את אותה הודעה, לעולם לא כפילות. פנייה שנתקעה ב-sending לא מאופסת ל-draft; משלימים אותה רק באישור
 *    חוזר מפורש של אותו משתמש (resend אידמפוטנטי + completeSend).
 *  • לא מדווחים "נשלח" אלא אם השליחה ידועה בוודאות. כשל באמצע → הודעה שאומרת במפורש שלא ידוע.
 *  • זהות: השולח הוא תמיד user.key (המשתמש המאומת); הנמען נפתר מול ספר הצוות בלבד, חד-משמעית.
 */

import { DateTime } from "luxon";
import { TEAM_DIRECTORY, getTeamMemberByKey, type TeamMember } from "../identity/directory.js";
import type { IdentifiedUser } from "../identity/index.js";
import {
  cancelDraft,
  claimForSending,
  completeSend,
  createDraft,
  expireDrafts,
  getOutreachInSession,
  getPendingDraft,
  listOutreach,
  listSending,
  outreachClientMessageId,
  type AgentOutreach,
  type CompleteSendResult,
} from "../db/repositories/agentOutreach.js";
import { TEAM_MESSAGE_MAX } from "../db/repositories/teamMessages.js";
import { sendDirectTeamMessage } from "./teamDelivery.js";
import { isExplicitConfirmation } from "./bulkUpdate.js";
import { logger } from "../utils/logger.js";

export const OUTREACH_TTL_MINUTES = 30;

export interface OutreachContext {
  sessionId: string;
  turnId: string;
  now: DateTime;
}

export type OutreachStepResult =
  | { ok: true; text: string; outreachId?: string; executed?: boolean; recipientName?: string }
  | { ok: false; error: string };

export interface OutreachDeps {
  sendDirect?: typeof sendDirectTeamMessage;
  complete?: (id: string, userKey: string, teamMessageId: number, threadId: number) => CompleteSendResult;
}

const fail = (error: string): OutreachStepResult => ({ ok: false, error });
const quote = (s: string) => `«${s}»`;
const nameOf = (key: string) => getTeamMemberByKey(key)?.name ?? key;

// ---------------------------------------------------------------------------
// זיהוי הנמען — חד-משמעי מול ספר הצוות
// ---------------------------------------------------------------------------

const lower = (s: string) => s.trim().toLowerCase();
const termsOf = (m: TeamMember) => [m.name, m.key, ...(m.aliases ?? [])].map(lower);

/** התאמה מדויקת (שם/מפתח/כינוי) ואז חלקית; בדיוק חבר צוות אחד, אחרת שגיאה ברורה. לא מסנן את עצמו כאן. */
export function resolveOutreachRecipient(query: unknown): { ok: true; member: TeamMember } | { ok: false; error: string } {
  const q0 = typeof query === "string" ? lower(query.replace(/["'«»]/g, "")) : "";
  if (q0.length < 2) return { ok: false, error: "לא ציינת למי לפנות. מה שם העובד?" };
  const attempt = (q: string): TeamMember[] => {
    const exact = TEAM_DIRECTORY.filter((m) => termsOf(m).includes(q));
    if (exact.length) return exact;
    return TEAM_DIRECTORY.filter((m) => termsOf(m).some((t) => t.includes(q) || (t.length >= 2 && q.includes(t))));
  };
  let found = attempt(q0);
  if (found.length === 0 && q0.startsWith("ל") && q0.length > 2) found = attempt(q0.slice(1)); // "לדוב"
  if (found.length === 0) return { ok: false, error: `לא מצאתי בצוות עובד בשם "${query}". אפשר לפנות רק לעובדי המשרד: ${TEAM_DIRECTORY.map((m) => m.name).join(", ")}.` };
  if (found.length > 1) return { ok: false, error: `"${query}" מתאים ליותר מעובד אחד (${found.map((m) => m.name).join(", ")}). למי בדיוק?` };
  return { ok: true, member: found[0]! };
}

// ---------------------------------------------------------------------------
// הכנה
// ---------------------------------------------------------------------------

export function prepareTeamOutreach(user: IdentifiedUser, ctx: OutreachContext, input: { recipient?: unknown; text?: unknown }): OutreachStepResult {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return fail("אין נוסח להודעה. מה לכתוב לעובד?");
  if (Array.from(text).length > TEAM_MESSAGE_MAX) return fail(`ההודעה ארוכה מדי (עד ${TEAM_MESSAGE_MAX} תווים).`);
  const r = resolveOutreachRecipient(input.recipient);
  if (!r.ok) return fail(r.error);
  if (r.member.key === user.key) return fail("אי אפשר לשלוח הודעה לעצמך.");
  const draft = createDraft({
    userKey: user.key,
    sessionId: ctx.sessionId,
    recipientKey: r.member.key,
    body: text,
    createdTurn: ctx.turnId,
    expiresAt: ctx.now.plus({ minutes: OUTREACH_TTL_MINUTES }).toJSDate(),
  });
  return {
    ok: true,
    outreachId: draft.id,
    text: `אשלח ל${r.member.name}, בשמך, דרך "הודעות צוות":\n${quote(draft.body)}\n\nלשלוח? (כן / לא — או כתוב מה לשנות)`,
  };
}

// ---------------------------------------------------------------------------
// אישור ושליחה
// ---------------------------------------------------------------------------

export async function confirmTeamOutreach(
  user: IdentifiedUser,
  ctx: OutreachContext & { latestUserMessage: string },
  input: { outreachId?: string },
  deps: OutreachDeps = {},
): Promise<OutreachStepResult> {
  const sendFn = deps.sendDirect ?? sendDirectTeamMessage;
  const completeFn = deps.complete ?? completeSend;
  const nowDate = ctx.now.toJSDate();

  let o: AgentOutreach | null;
  if (input.outreachId) {
    o = getOutreachInSession(input.outreachId, user.key, ctx.sessionId);
  } else {
    o = getPendingDraft(user.key, ctx.sessionId, nowDate);
    if (!o) {
      const stuck = listSending(user.key).filter((s) => s.sessionId === ctx.sessionId);
      if (stuck.length > 1) {
        return fail(`יש כמה פניות שנתקעו באמצע שליחה (${stuck.map((s) => `${s.id} → ${nameOf(s.recipientKey)}`).join("; ")}). ציין איזו להשלים.`);
      }
      o = stuck[0] ?? null;
    }
  }
  if (!o) {
    const last = listOutreach(user.key, ctx.sessionId).at(-1);
    if (last && (last.status === "expired" || (last.status === "draft" && new Date(last.expiresAt) <= nowDate))) {
      return fail("הטיוטה פגה — לא שלחתי כלום. אם עדיין רלוונטי, אכין אותה מחדש.");
    }
    return fail("אין פנייה לעובד שממתינה לאישור בשיחה הזו.");
  }

  const name = nameOf(o.recipientKey);
  switch (o.status) {
    case "sent":
      return { ok: true, executed: false, outreachId: o.id, text: `ההודעה ל${name} כבר נשלחה — לא שלחתי שוב.` };
    case "cancelled":
      return fail("הפנייה הזו בוטלה או הוחלפה בנוסח חדש יותר — לא שלחתי כלום.");
    case "expired":
      return fail("הטיוטה פגה — לא שלחתי כלום. אם עדיין רלוונטי, אכין אותה מחדש.");
  }

  if (o.status === "draft") {
    if (new Date(o.expiresAt) <= nowDate) {
      expireDrafts(nowDate);
      return fail("הטיוטה פגה — לא שלחתי כלום. אם עדיין רלוונטי, אכין אותה מחדש.");
    }
    if (o.createdTurn === ctx.turnId) {
      return fail("אסור לשלוח באותה הודעה שבה הוכנה הפנייה — הצג אותה למשתמש וחכה לאישור מפורש ממנו.");
    }
  }
  // draft וגם sending (השלמת פנייה תקועה) דורשים אישור מפורש של המשתמש בהודעה האחרונה.
  if (!isExplicitConfirmation(ctx.latestUserMessage)) {
    return fail(
      o.status === "sending"
        ? `פנייה ל${name} נתקעה באמצע שליחה ולא ידוע אם הגיעה. כדי להשלים בבטחה (בלי לשלוח פעמיים) צריך אישור מפורש — "כן".`
        : `זה לא אישור חד-משמעי — לא שלחתי כלום. אם רוצה לשנות נוסח או נמען, אכין הודעה חדשה; אחרת אשר במפורש ("כן") או בטל.`,
    );
  }

  const recovering = o.status === "sending";
  if (!recovering && !claimForSending(o.id, user.key, ctx.sessionId, nowDate)) {
    return fail("הפנייה כבר אושרה במקביל או שאינה זמינה יותר — לא שלחתי שוב.");
  }

  let sent: ReturnType<typeof sendDirectTeamMessage>;
  try {
    sent = sendFn(user.key, o.recipientKey, o.body, outreachClientMessageId(o.id));
  } catch (err) {
    logger.warn({ err, user: user.key, outreachId: o.id }, "שליחת פנייה לעובד נכשלה — נשארת ב-sending");
    return fail(
      `לא הצלחתי לאמת שההודעה ל${name} נשלחה, ולא ידוע אם הגיעה. אל תניח שנשלחה. אפשר לאשר שוב ("כן") — אשלים בבטחה בלי לשלוח פעמיים.`,
    );
  }

  let recorded = true;
  try {
    recorded = completeFn(o.id, user.key, sent.message.id, sent.threadId) === "ok";
  } catch (err) {
    logger.warn({ err, user: user.key, outreachId: o.id }, "השלמת רישום פנייה נכשלה אחרי שליחה — ניתן לשחזר עם ao:<id>");
    recorded = false;
  }
  if (!recorded) logger.warn({ user: user.key, outreachId: o.id }, "פנייה נשלחה אך לא תועדה כ-sent");

  const already = sent.duplicate;
  const base = already
    ? `ההודעה ל${name} כבר נשלחה קודם — לא שלחתי שוב.`
    : `✓ נשלחה ל${name}, בשמך: ${quote(o.body)}`;
  return {
    ok: true,
    executed: !already,
    outreachId: o.id,
    recipientName: name,
    text: recorded ? base : `${base}\n(הרישום הפנימי של הפנייה לא הושלם; אישור חוזר ישלים אותו בלי לשלוח שוב.)`,
  };
}

// ---------------------------------------------------------------------------
// ביטול
// ---------------------------------------------------------------------------

export function cancelTeamOutreach(user: IdentifiedUser, ctx: { sessionId: string; now: DateTime }): OutreachStepResult {
  const draft = getPendingDraft(user.key, ctx.sessionId, ctx.now.toJSDate());
  if (draft) {
    cancelDraft(draft.id, user.key, ctx.sessionId);
    return { ok: true, text: `בוטל — לא שלחתי הודעה ל${nameOf(draft.recipientKey)}.` };
  }
  const stuck = listSending(user.key).filter((s) => s.sessionId === ctx.sessionId);
  if (stuck.length) {
    return fail(`לא ניתן לבטל: פנייה ל${nameOf(stuck[0]!.recipientKey)} נתקעה באמצע שליחה ויתכן שכבר הגיעה. אפשר להשלים אותה באישור, או לבדוק בלשונית "הודעות צוות".`);
  }
  return fail("אין פנייה לעובד שממתינה לאישור.");
}

// ---------------------------------------------------------------------------
// הקשר לשיחה + ניתוב
// ---------------------------------------------------------------------------

/** שורות הקשר לחלק המשתנה של ה-system prompt — רק כשיש פנייה ממתינה/תקועה בשיחה. אחרת []. */
export function buildOutreachContextLines(userKey: string, sessionId: string, now: DateTime): string[] {
  const lines: string[] = [];
  const draft = getPendingDraft(userKey, sessionId, now.toJSDate());
  if (draft) {
    lines.push(
      `• פנייה ל${nameOf(draft.recipientKey)} ממתינה לאישור (${draft.id}): ${quote(draft.body)}. ` +
        "אישור מפורש של המשתמש ('כן', 'שלח') → confirm_team_outreach. בקשת שינוי נוסח/נמען → prepare_team_outreach מחדש (בלי confirm). 'בטל' / 'לא' → cancel_team_outreach. אל תנסח שנשלחה לפני שהכלי אישר.",
    );
  }
  for (const s of listSending(userKey).filter((x) => x.sessionId === sessionId)) {
    lines.push(
      `• פנייה ל${nameOf(s.recipientKey)} (${s.id}) נתקעה באמצע שליחה — לא ידוע אם הגיעה. אל תגיד שנשלחה. הצע למשתמש לאשר שוב להשלמה בטוחה; אישור מפורש → confirm_team_outreach עם outreachId="${s.id}".`,
    );
  }
  return lines.length ? ["", "מצב פניות לעובדים בשיחה (נתון מערכת):", ...lines] : [];
}

const OUTREACH_VERB = /(תשאל|שאל|תבקש|בקש|תפנה|פנה|תשלח|שלח|תגיד|תכתוב|כתוב|תודיע|הודע)/;
const firstNames = TEAM_DIRECTORY.flatMap((m) => [m.name.split(/\s+/)[0]!, ...(m.aliases ?? [])]).filter((n) => n.length >= 2);
const OUTREACH_TARGET = new RegExp(`(הודעה|${firstNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");

/** בקשה שנראית כפנייה לעובד, או שיחה עם פנייה ממתינה/תקועה → SMART (דיוק בפעולה שיוצאת החוצה חשוב מהעלות). */
export function looksLikeOutreachRequest(text: string): boolean {
  return OUTREACH_VERB.test(text) && OUTREACH_TARGET.test(text);
}
