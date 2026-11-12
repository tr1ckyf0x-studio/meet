import { applyStroke, type Iv, type Mark } from "../shared/intervals";
import { t, type Lang } from "../shared/i18n";
import { DailyBudget } from "./budget";
import { RateLimiter } from "./rate-limit";
import { addDays, DAY, MIN, startOfDay } from "../shared/time";
import { memberUnavailable, suggest, type Suggestions } from "./availability";
import type { Syncer } from "./calendars/sync";
import { newId } from "./crypto";
import type { Connection, Group, MemberView, Proposal, Store, User } from "./db";
import { buildEventIcs, buildFeed, googleCalendarLink, type IcsEvent } from "./ics";
import { meetingMail, type Mailer } from "./mail";

export interface Ctx {
  store: Store;
  mailer: Mailer;
  syncer: Syncer;
  publicUrl: string;
  now: () => number;
  log: (msg: string) => void;
  /** The address invitations name as ORGANIZER (the sender). */
  organizerEmail?: string;
  /** Meeting emails per day, all groups together (the relay's quota is shared). */
  meetingMails?: DailyBudget;
  /** Cancellations per group per day, so propose-confirm-cancel cannot be looped into a mail flood. */
  cancels?: RateLimiter;
}

export function defaultLimits(now: () => number) {
  return { meetingMails: new DailyBudget(200, now), cancels: new RateLimiter(3, 86_400_000, now) };
}

export const MAX_MEMBERS = 50;
export const MAX_OPEN_PROPOSALS = 30;
export const MAX_MARKS = 3000;

export function bounds(g: Pick<Group, "rangeStart" | "rangeEnd" | "tz">): { lo: number; hi: number } {
  return { lo: startOfDay(g.rangeStart, g.tz), hi: startOfDay(addDays(g.rangeEnd, 1), g.tz) };
}

const host = (ctx: Ctx) => new URL(ctx.publicUrl).host;
export const groupUrl = (ctx: Ctx, g: Group) => `${ctx.publicUrl}/groups/${g.id}`;
export const inviteUrl = (ctx: Ctx, g: Group) => `${ctx.publicUrl}/g/${g.invite}`;
export const feedUrl = (ctx: Ctx, token: string) => `${ctx.publicUrl}/feed/${token}.ics`;

/** The connections of a member that count in this group. */
export function usedConnections(m: Pick<MemberView, "calendars">, conns: Connection[]): Connection[] {
  return m.calendars === null ? conns : conns.filter((c) => m.calendars!.includes(c.id));
}

interface Computed {
  member: MemberView;
  conns: Connection[];
  used: Connection[];
  /** Used calendars that synced fine; only these count as availability. */
  working: Connection[];
  calendarBusy: Iv[];
  unavailable: Iv[];
  responded: boolean;
}

function compute(ctx: Ctx, g: Group, members: MemberView[]): Computed[] {
  const { lo, hi } = bounds(g);
  return members.map((m) => {
    const conns = ctx.store.connectionsOfUser(m.userId);
    const used = usedConnections(m, conns);
    // A calendar that has not synced yet, or failed, says nothing: counting it would make its owner look
    // free all the time.
    const working = used.filter((c) => c.status === "ok");
    const calendarBusy = ctx.store.busy(working.map((c) => c.id), lo, hi);
    const hasCalendars = working.length > 0;
    return {
      member: m, conns, used, working, calendarBusy,
      unavailable: memberUnavailable({ lo, hi, hasCalendars, calendarBusy, marks: m.marks }),
      responded: hasCalendars || m.marks.length > 0,
    };
  });
}

export interface ProposalView {
  id: string;
  start: number;
  end: number;
  createdBy: string | null;
  status: Proposal["status"];
  votes: Record<string, { yes: boolean; byOrganizer: boolean }>;
}

export interface GroupState {
  rev: number;
  now: number;
  me: { id: string; isOrganizer: boolean; tz: string; lang: Lang; name: string };
  group: {
    id: string; title: string; address: string; durationMin: number; rangeStart: string; rangeEnd: string; tz: string;
    lo: number; hi: number; expiresOn: string; organizerId: string; inviteUrl: string; feedUrl: string;
    confirmedId: string | null;
  };
  members: {
    id: string; name: string; tz: string; isOrganizer: boolean; responded: boolean; hasCalendars: boolean;
    calendarProblem: boolean; calendarSyncing: boolean; unavailable: Iv[];
  }[];
  mine: {
    marks: Mark[];
    calendarBusy: Iv[];
    usesAll: boolean;
    connections: { id: string; label: string; kind: string; status: string; error: string | null; syncedAt: number | null; used: boolean }[];
  };
  suggestions: Suggestions;
  proposals: ProposalView[];
}

/** A member's name as others see it. Never derived from the email address. */
export function displayName(m: { name: string }, lang: Lang, n: number): string {
  return m.name.trim() || t(lang, "member_n", { n });
}

/** Everything the group page shows to one member. Other members' busy time is merged and clipped to the range. */
export function groupState(ctx: Ctx, g: Group, viewer: User): GroupState {
  const members = ctx.store.members(g.id);
  const computed = compute(ctx, g, members);
  const { lo, hi } = bounds(g);
  const me = computed.find((c) => c.member.userId === viewer.id)!;
  const votes = ctx.store.votes(g.id);
  return {
    rev: g.rev,
    now: ctx.now(),
    me: { id: viewer.id, isOrganizer: g.organizerId === viewer.id, tz: viewer.tz, lang: viewer.lang, name: displayName(viewer, viewer.lang, computed.indexOf(me) + 1) },
    group: {
      id: g.id, title: g.title, address: g.address, durationMin: g.durationMin, rangeStart: g.rangeStart, rangeEnd: g.rangeEnd,
      tz: g.tz, lo, hi, expiresOn: g.expiresOn, organizerId: g.organizerId,
      inviteUrl: inviteUrl(ctx, g), feedUrl: feedUrl(ctx, me.member.feedToken), confirmedId: g.confirmedId,
    },
    members: computed.map((c, i) => ({
      id: c.member.userId, name: displayName(c.member, viewer.lang, i + 1), tz: c.member.tz, isOrganizer: c.member.userId === g.organizerId,
      responded: c.responded, hasCalendars: c.working.length > 0,
      calendarProblem: c.used.some((x) => x.status === "error"), calendarSyncing: c.used.some((x) => x.status === "new"),
      unavailable: c.unavailable,
    })),
    mine: {
      marks: me.member.marks,
      calendarBusy: me.calendarBusy,
      usesAll: me.member.calendars === null,
      connections: me.conns.map((c) => ({
        id: c.id, label: c.label, kind: c.kind, status: c.status, error: c.error, syncedAt: c.syncedAt, used: me.used.includes(c),
      })),
    },
    suggestions: suggest(computed.map((c) => ({ id: c.member.userId, responded: c.responded, unavailable: c.unavailable })), lo, hi, g.durationMin * MIN),
    proposals: ctx.store.proposals(g.id).filter((p) => p.status === "open" || p.status === "confirmed").map((p) => ({
      id: p.id, start: p.start, end: p.end, createdBy: p.createdBy, status: p.status,
      votes: Object.fromEntries(votes.filter((v) => v.proposalId === p.id).map((v) => [v.userId, { yes: v.yes, byOrganizer: v.setBy !== v.userId }])),
    })),
  };
}

/** Starts a background refresh of the calendars of everyone in the group that are older than 10 minutes. */
export function refreshGroupCalendars(ctx: Ctx, g: Group): void {
  for (const m of ctx.store.members(g.id)) ctx.syncer.kick(usedConnections(m, ctx.store.connectionsOfUser(m.userId)));
}

/* ---------- actions ---------- */

export type Result = { ok: true } | { ok: false; error: string; status?: number };
const fail = (error: string, status = 400): Result => ({ ok: false, error, status });
const OK: Result = { ok: true };

export function paint(ctx: Ctx, g: Group, userId: string, strokes: { start: number; end: number; state: "free" | "busy" | "clear" }[]): Result {
  const { lo, hi } = bounds(g);
  const m = ctx.store.getMember(g.id, userId);
  if (!m) return fail("not_member", 404);
  let marks = m.marks;
  for (const s of strokes) {
    const a = Math.max(lo, s.start), b = Math.min(hi, s.end);
    if (!(b > a)) continue;
    marks = applyStroke(marks, a, b, s.state === "clear" ? null : s.state === "free" ? 1 : 0);
  }
  if (marks.length > MAX_MARKS) return fail("too_many_marks");
  ctx.store.setMarks(g.id, userId, marks);
  return OK;
}

export function clearMarks(ctx: Ctx, g: Group, userId: string): Result {
  ctx.store.setMarks(g.id, userId, []);
  return OK;
}

export function setMyCalendars(ctx: Ctx, g: Group, userId: string, ids: string[] | null): Result {
  if (ids !== null) {
    const own = new Set(ctx.store.connectionsOfUser(userId).map((c) => c.id));
    if (!ids.every((id) => own.has(id))) return fail("bad_calendar");
    if (ids.length === own.size) ids = null;
  }
  ctx.store.setMemberCalendars(g.id, userId, ids);
  return OK;
}

export function propose(ctx: Ctx, g: Group, userId: string, start: number): Result & { id?: string } {
  if (g.confirmedId) return fail("already_confirmed", 409);
  const { lo, hi } = bounds(g);
  const end = start + g.durationMin * MIN;
  if (!Number.isFinite(start) || start < lo || end > hi + DAY) return fail("out_of_range");
  const open = ctx.store.proposals(g.id).filter((p) => p.status === "open");
  if (open.some((p) => p.start === start)) return fail("duplicate", 409);
  if (open.length >= MAX_OPEN_PROPOSALS) return fail("too_many_proposals", 409);
  const id = newId();
  ctx.store.tx(() => {
    ctx.store.createProposal({ id, groupId: g.id, start, end, createdBy: userId, createdAt: ctx.now(), status: "open" });
    ctx.store.setVote(id, userId, true, userId, ctx.now());
  });
  evaluate(ctx, g.id);
  return { ok: true, id };
}

export function vote(ctx: Ctx, g: Group, actorId: string, proposalId: string, targetId: string, yes: boolean | null): Result {
  if (g.confirmedId) return fail("already_confirmed", 409);
  const p = ctx.store.getProposal(proposalId);
  if (!p || p.groupId !== g.id || p.status !== "open") return fail("not_found", 404);
  if (actorId !== targetId && g.organizerId !== actorId) return fail("forbidden", 403);
  if (!ctx.store.getMember(g.id, targetId)) return fail("not_member", 404);
  ctx.store.setVote(p.id, targetId, yes, actorId, ctx.now());
  evaluate(ctx, g.id);
  return OK;
}

export function withdraw(ctx: Ctx, g: Group, actorId: string, proposalId: string): Result {
  const p = ctx.store.getProposal(proposalId);
  if (!p || p.groupId !== g.id || p.status !== "open") return fail("not_found", 404);
  if (p.createdBy !== actorId && g.organizerId !== actorId) return fail("forbidden", 403);
  ctx.store.setProposalStatus(p.id, "withdrawn");
  return OK;
}

export function removeMember(ctx: Ctx, g: Group, actorId: string, targetId: string): Result {
  if (targetId === g.organizerId) return fail("organizer_stays", 409);
  if (actorId !== targetId && actorId !== g.organizerId) return fail("forbidden", 403);
  if (!ctx.store.getMember(g.id, targetId)) return fail("not_member", 404);
  ctx.store.removeMember(g.id, targetId);
  evaluate(ctx, g.id);
  return OK;
}

/** Adds a member. A meeting that is already set is mailed to the newcomer. */
export function join(ctx: Ctx, g: Group, user: User): Result {
  if (ctx.store.getMember(g.id, user.id)) return OK;
  if (ctx.store.countMembers(g.id) >= MAX_MEMBERS) return fail("full", 409);
  ctx.store.addMember({ groupId: g.id, userId: user.id, joinedAt: ctx.now(), feedToken: newId() + newId(), calendars: null, marks: [] });
  const fresh = ctx.store.getGroup(g.id)!;
  if (fresh.confirmedId) {
    const p = ctx.store.getProposal(fresh.confirmedId);
    const m = ctx.store.members(g.id).find((x) => x.userId === user.id);
    if (p && m) sendMeetingMails(ctx, fresh, p, [m], false);
  } else evaluate(ctx, g.id);
  return OK;
}

/** Sets the meeting as soon as every member has said yes to an open proposal. */
export function evaluate(ctx: Ctx, groupId: string): void {
  const g = ctx.store.getGroup(groupId);
  if (!g || g.confirmedId) return;
  const memberIds = ctx.store.members(g.id).map((m) => m.userId);
  if (memberIds.length < 2) return; // the organizer alone does not make a meeting
  const votes = ctx.store.votes(g.id);
  const agreed = ctx.store.proposals(g.id).filter((p) => p.status === "open" &&
    memberIds.every((uid) => votes.some((v) => v.proposalId === p.id && v.userId === uid && v.yes)));
  const p = agreed[0];
  if (!p) return;
  ctx.store.tx(() => {
    ctx.store.setProposalStatus(p.id, "confirmed");
    ctx.store.setConfirmed(g.id, p.id);
  });
  const fresh = ctx.store.getGroup(g.id)!;
  sendMeetingMails(ctx, fresh, p, ctx.store.members(g.id), false);
}

export function cancelMeeting(ctx: Ctx, g: Group, actorId: string, force = false): Result {
  if (actorId !== g.organizerId) return fail("forbidden", 403);
  if (!g.confirmedId) return fail("not_confirmed", 409);
  if (!force && ctx.cancels && !ctx.cancels.allow(g.id)) return fail("too_many_changes", 429);
  const p = ctx.store.getProposal(g.confirmedId);
  ctx.store.tx(() => {
    if (p) ctx.store.setProposalStatus(p.id, "cancelled");
    // Other proposals everyone had agreed to would otherwise set themselves on the next vote: start over.
    for (const x of ctx.store.proposals(g.id)) if (x.status === "open") ctx.store.setProposalStatus(x.id, "withdrawn");
    ctx.store.setConfirmed(g.id, null);
  });
  const fresh = ctx.store.getGroup(g.id)!;
  if (p) sendMeetingMails(ctx, fresh, p, ctx.store.members(g.id), true);
  return OK;
}

export function meetingEvent(ctx: Ctx, g: Group, p: Pick<Proposal, "start" | "end">, status: IcsEvent["status"]): IcsEvent {
  return {
    uid: `${g.id}@${host(ctx)}`, seq: g.seq, start: p.start, end: p.end, title: g.title,
    location: g.address || undefined, description: groupUrl(ctx, g), url: groupUrl(ctx, g), status,
    organizer: ctx.organizerEmail ? { name: "meet", email: ctx.organizerEmail } : undefined,
  };
}

/** After the organizer renamed a set meeting or changed its address: a new SEQUENCE and the update to everyone. */
export function meetingChanged(ctx: Ctx, groupId: string): void {
  const g = ctx.store.getGroup(groupId);
  const p = g?.confirmedId ? ctx.store.getProposal(g.confirmedId) : null;
  if (!g || !p) return;
  ctx.store.setConfirmed(g.id, p.id);
  sendMeetingMails(ctx, ctx.store.getGroup(g.id)!, p, ctx.store.members(g.id), false, true);
}

function sendMeetingMails(ctx: Ctx, g: Group, p: Proposal, to: MemberView[], cancelled: boolean, updated = false): void {
  if (ctx.meetingMails && !ctx.meetingMails.take(to.length)) {
    ctx.log(`meeting mails of ${g.id} skipped: the daily mail budget is spent`);
    return;
  }
  const event = meetingEvent(ctx, g, p, cancelled ? "CANCELLED" : "CONFIRMED");
  const ics = buildEventIcs(event, cancelled ? "CANCEL" : "PUBLISH", ctx.now());
  const gcalUrl = googleCalendarLink({ title: g.title, start: p.start, end: p.end, location: g.address || undefined, details: groupUrl(ctx, g) });
  for (const m of to) {
    const mail = meetingMail({
      to: m.email, lang: m.lang, tz: m.tz, title: g.title, address: g.address, start: p.start, end: p.end,
      pageUrl: groupUrl(ctx, g), gcalUrl, ics, cancelled, updated,
    });
    ctx.mailer.send(mail).catch((e) => ctx.log(`mail to member of ${g.id} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
  }
}

/** A member's subscription: the meeting once set, else the open proposals as tentative (free) events. */
export function feedFor(ctx: Ctx, g: Group): string {
  const events: IcsEvent[] = [];
  if (g.confirmedId) {
    const p = ctx.store.getProposal(g.confirmedId);
    if (p) events.push(meetingEvent(ctx, g, p, "CONFIRMED"));
  } else {
    for (const p of ctx.store.proposals(g.id).filter((x) => x.status === "open")) {
      events.push({ ...meetingEvent(ctx, g, p, "TENTATIVE"), uid: `${p.id}@${host(ctx)}`, seq: 0, title: `${g.title} (?)` });
    }
  }
  return buildFeed(g.title, events, ctx.now());
}
