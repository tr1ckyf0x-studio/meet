/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { isLang, pickLang, t, type Key, type Lang } from "../shared/i18n";
import { addDays, daysBetween, isValidTz, parseYmd, startOfDay, ymdOf } from "../shared/time";
import { CALDAV_PROVIDERS, discoverCalendars, type CaldavSecret } from "./calendars/caldav";
import { FetchError, parseUserUrl, type GuardOptions } from "./calendars/fetchguard";
import { icsBusy, normalizeIcsUrl } from "./calendars/icsurl";
import { authUrl, exchangeCode, listCalendars, type OAuthApp, type OAuthSecret, type Provider } from "./calendars/oauth";
import { newId, newToken, pkceChallenge, safeEqual, sha256, type Sealer } from "./crypto";
import type { Connection, Group, User } from "./db";
import { clientIp, sameOrigin } from "./http";
import { loginMail } from "./mail";
import {
  cancelMeeting, clearMarks, displayName, feedFor, groupState, join, meetingEvent, paint, propose,
  refreshGroupCalendars, removeMember, setMyCalendars, usedConnections, vote, withdraw, type Ctx, type Result, MAX_MEMBERS,
} from "./meeting";
import { buildEventIcs } from "./ics";
import { RateLimiter } from "./rate-limit";
import * as V from "./views";

export interface AppOptions extends Ctx {
  sealer: Sealer;
  signupCode: string;
  apps: Partial<Record<Provider, OAuthApp>>;
  guard: GuardOptions;
  secureCookies: boolean;
  revision: string;
  /** name -> [content type, body] for /static. */
  assets: Map<string, [string, Uint8Array | string]>;
}

type Env = { Variables: { user: User | null; lang: Lang } };
type C = Context<Env>;

const DAY = 86_400_000;
const SESSION_TTL = 90 * DAY;
const LOGIN_TTL = 15 * 60_000;
const MAX_GROUPS = 50;
const MAX_CONNECTIONS = 10;

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
].join("; ");

const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Only local paths, so a crafted ?next= cannot send anyone to another site. */
export function safeNext(next: unknown, fallback = "/"): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}
const safeBack = (b: unknown): string | undefined => (typeof b === "string" && /^\/groups\/[A-Za-z0-9_-]{1,40}$/.test(b) ? b : undefined);

let zonesCache: string[] | null = null;
function zones(): string[] {
  if (!zonesCache) {
    const list = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    zonesCache = list.includes("UTC") ? list : ["UTC", ...list];
  }
  return zonesCache;
}

export function createApp(o: AppOptions) {
  const { store } = o;
  const now = o.now;
  const cookieName = o.secureCookies ? "__Host-sid" : "sid";
  const ipLimiter = new RateLimiter(30, 60 * 60_000, now);
  const emailLimiter = new RateLimiter(5, 60 * 60_000, now);
  const connectLimiter = new RateLimiter(20, 60 * 60_000, now);

  const assetVersion = o.revision.slice(0, 12);
  const asset = (name: string) => `/static/${name}?v=${assetVersion}`;
  const base = (c: C) => ({ lang: c.var.lang, user: c.var.user, asset });
  const render = (c: C, node: unknown, status = 200) => {
    c.header("Cache-Control", "no-store");
    return c.html("<!DOCTYPE html>" + String(node), status as 200);
  };
  const notFound = (c: C) => render(c, <V.Message {...base(c)} title={tt(c, "notfound_title")} text={tt(c, "notfound_text")} />, 404);
  const tt = (c: C, k: Key, v?: Record<string, string | number>) => t(c.var.lang, k, v);

  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (o.secureCookies) c.header("Strict-Transport-Security", "max-age=31536000");
  });

  app.use("*", async (c, next) => {
    const sid = getCookie(c, cookieName);
    const user = sid ? store.sessionUser(sha256(sid), now()) : null;
    c.set("user", user);
    const cl = getCookie(c, "lang");
    c.set("lang", user?.lang ?? (isLang(cl) ? cl : pickLang(c.req.header("accept-language"))));
    await next();
  });

  app.use("*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.text("too large", 413) }));

  // CSRF: every state-changing request comes from our own origin; API calls are JSON.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (!sameOrigin(c)) return c.text("bad origin", 403);
      if (c.req.path.startsWith("/api/") && !(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "json_only" }, 415);
    }
    await next();
  });

  const startSession = (c: C, user: User) => {
    const sid = newToken();
    store.createSession(sha256(sid), user.id, now() + SESSION_TTL);
    setCookie(c, cookieName, sid, { path: "/", httpOnly: true, secure: o.secureCookies, sameSite: "Lax", maxAge: SESSION_TTL / 1000 });
  };

  const form = async (c: C): Promise<Record<string, string | string[]>> => {
    const f = await c.req.parseBody({ all: true }).catch(() => ({}));
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(f)) out[k] = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? v : "";
    return out;
  };
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? "") : "");

  const requireUser = (c: C): User | Response => c.var.user ?? c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 303);

  app.get("/api/health", (c) => c.json({ ok: true, revision: o.revision }));

  app.get("/static/:file{[A-Za-z0-9_.-]+}", (c) => {
    const a = o.assets.get(c.req.param("file"));
    if (!a) return c.notFound();
    const versioned = c.req.query("v") === assetVersion;
    c.header("Cache-Control", versioned ? "public, max-age=31536000, immutable" : "no-cache");
    return c.body(a[1] as string, 200, { "Content-Type": a[0] });
  });

  app.get("/lang/:lang", (c) => {
    const l = c.req.param("lang");
    if (isLang(l)) {
      setCookie(c, "lang", l, { path: "/", maxAge: 365 * 86400, sameSite: "Lax", secure: o.secureCookies });
      if (c.var.user) store.updateUser(c.var.user.id, { lang: l });
    }
    let back = "/";
    try {
      const ref = new URL(c.req.header("referer") ?? "");
      if (ref.host === c.req.header("host")) back = safeNext(ref.pathname + ref.search);
    } catch { /* no referer */ }
    return c.redirect(back, 303);
  });

  /* ---------- auth ---------- */

  app.get("/", (c) => {
    const u = c.var.user;
    if (!u) return render(c, <V.Landing {...base(c)} />);
    return render(c, <V.HomePage {...base(c)} user={u} groups={store.groupsOfUser(u.id)} />);
  });

  app.get("/login", (c) => (c.var.user ? c.redirect(safeNext(c.req.query("next")), 303) : render(c, <V.LoginPage {...base(c)} next={safeNext(c.req.query("next"), "")} />)));

  app.get("/register", (c) => {
    const code = c.req.query("code") ?? "";
    if (!o.signupCode || !safeEqual(code, o.signupCode)) return render(c, <V.Message {...base(c)} title={tt(c, "register_title")} text={tt(c, "register_bad_code")} />, 403);
    return render(c, <V.RegisterPage {...base(c)} code={code} />);
  });

  app.post("/login", async (c) => {
    const f = await form(c);
    const parsed = Email.safeParse(str(f.email));
    const invite = str(f.invite), code = str(f.code), next = safeNext(str(f.next), "");
    const again = (error: string) => {
      if (invite) {
        const g = store.getGroupByInvite(invite);
        if (g) return render(c, invitePage(c, g, str(f.email), error), 400);
      }
      if (code) return render(c, <V.RegisterPage {...base(c)} code={code} error={error} />, 400);
      return render(c, <V.LoginPage {...base(c)} email={str(f.email)} next={next} error={error} />, 400);
    };
    if (!parsed.success) return again("login_bad_email");
    const email = parsed.data;
    if (!ipLimiter.allow(clientIp(c)) || !emailLimiter.allow(email)) return again("login_rate");

    const existing = store.getUserByEmail(email);
    const group = invite ? store.getGroupByInvite(invite) : null;
    const codeOk = !!code && !!o.signupCode && safeEqual(code, o.signupCode);
    if (existing || group || codeOk) {
      const token = newToken();
      store.createLoginToken({
        hash: sha256(token), email, invite: group?.invite ?? null, signup: !existing && (codeOk || !!group),
        next: next || null, lang: c.var.lang, expiresAt: now() + LOGIN_TTL,
      });
      const lang = existing?.lang ?? c.var.lang;
      o.mailer.send(loginMail(email, `${o.publicUrl}/auth?t=${token}`, lang))
        .catch((e) => o.log(`login mail failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
    }
    // The same answer either way, so the form does not reveal who has an account.
    return render(c, <V.SentPage {...base(c)} email={email} />);
  });

  app.get("/auth", (c) => {
    const token = c.req.query("t") ?? "";
    const row = token ? store.peekLoginToken(sha256(token), now()) : null;
    if (!row) return render(c, <V.Message {...base(c)} title={tt(c, "auth_title")} text={tt(c, "auth_invalid")} link={{ href: "/login", label: tt(c, "login_send") }} />, 400);
    return render(c, <V.AuthPage {...base(c)} token={token} email={row.email} />);
  });

  app.post("/auth", async (c) => {
    const f = await form(c);
    const row = store.takeLoginToken(sha256(str(f.t)), now());
    const invalid = () => render(c, <V.Message {...base(c)} title={tt(c, "auth_title")} text={tt(c, "auth_invalid")} link={{ href: "/login", label: tt(c, "login_send") }} />, 400);
    if (!row) return invalid();
    let user = store.getUserByEmail(row.email);
    const group = row.invite ? store.getGroupByInvite(row.invite) : null;
    if (!user) {
      if (!row.signup || (row.invite && !group)) return invalid();
      const nu: User = { id: newId(), email: row.email, name: "", tz: "UTC", lang: row.lang ?? c.var.lang, createdAt: now() };
      if (!store.createUser(nu)) return invalid();
      user = nu;
    }
    startSession(c, user);
    let dest = safeNext(row.next ?? "/");
    if (group) {
      const r = join(o, group, user);
      if (!r.ok) return render(c, <V.Message {...base(c)} user={user} title={group.title} text={tt(c, "invite_full")} />, 409);
      dest = `/groups/${group.id}`;
    }
    return c.redirect(user.name ? dest : `/welcome?next=${encodeURIComponent(dest)}`, 303);
  });

  app.get("/welcome", (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    return render(c, <V.WelcomePage {...base(c)} user={u} next={safeNext(c.req.query("next"))} zones={zones()} now={now()} />);
  });

  app.post("/welcome", async (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const f = await form(c);
    saveProfile(u, f);
    return c.redirect(safeNext(str(f.next)), 303);
  });

  const saveProfile = (u: User, f: Record<string, string | string[]>) => {
    const name = str(f.name).trim().replace(/\s+/g, " ").slice(0, 60);
    const tz = str(f.tz);
    const lang = str(f.lang);
    store.updateUser(u.id, { name: name || u.name, tz: isValidTz(tz) ? tz : u.tz, lang: isLang(lang) ? lang : u.lang });
  };

  app.post("/logout", (c) => {
    const sid = getCookie(c, cookieName);
    if (sid) store.deleteSession(sha256(sid));
    deleteCookie(c, cookieName, { path: "/", secure: o.secureCookies });
    return c.redirect("/", 303);
  });

  /* ---------- settings ---------- */

  app.get("/settings", (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    return render(c, <V.SettingsPage {...base(c)} user={u} zones={zones()} now={now()} saved={c.req.query("saved") === "1"} />);
  });

  app.post("/settings", async (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    saveProfile(u, await form(c));
    return c.redirect("/settings?saved=1", 303);
  });

  app.post("/settings/delete", (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    for (const g of store.groupsOfUser(u.id)) {
      if (g.organizerId === u.id && g.confirmedId) cancelIfUpcoming(g);
    }
    store.deleteUser(u.id);
    deleteCookie(c, cookieName, { path: "/", secure: o.secureCookies });
    return c.redirect("/", 303);
  });

  const cancelIfUpcoming = (g: Group) => {
    const p = g.confirmedId ? store.getProposal(g.confirmedId) : null;
    if (p && p.end > now()) cancelMeeting(o, g, g.organizerId);
  };

  /* ---------- groups: pages ---------- */

  interface Parsed { ok: true; v: V.GroupFormValues; durationMin: number; expiresAt: number }
  const parseGroupForm = (f: Record<string, string | string[]>, tzFixed?: string): Parsed | { ok: false; error: string; v: V.GroupFormValues } => {
    const num = (k: string) => Math.max(0, Math.floor(Number(str(f[k])) || 0));
    const v: V.GroupFormValues = {
      title: str(f.title).trim().replace(/\s+/g, " ").slice(0, 120),
      days: num("days"), hours: num("hours"), minutes: num("minutes"),
      rangeStart: str(f.rangeStart), rangeEnd: str(f.rangeEnd), address: str(f.address).trim().slice(0, 300),
      expiresOn: str(f.expiresOn), tz: tzFixed ?? str(f.tz),
    };
    const bad = (error: string) => ({ ok: false as const, error, v });
    if (!v.title) return bad("err_title");
    const durationMin = v.days * 1440 + v.hours * 60 + v.minutes;
    if (durationMin < 15 || durationMin > 14 * 1440) return bad("err_duration");
    if (!isValidTz(v.tz)) return bad("err_tz");
    if (!parseYmd(v.rangeStart) || !parseYmd(v.rangeEnd)) return bad("err_range");
    const span = daysBetween(v.rangeStart, v.rangeEnd);
    if (span < 0 || span > 91) return bad("err_range");
    const today = ymdOf(now(), v.tz);
    if (daysBetween(today, v.rangeEnd) < 0) return bad("err_range_past");
    if (!parseYmd(v.expiresOn) || daysBetween(v.rangeEnd, v.expiresOn) < 0 || daysBetween(today, v.expiresOn) > 366) return bad("err_expires");
    return { ok: true, v, durationMin, expiresAt: startOfDay(addDays(v.expiresOn, 1), v.tz) };
  };

  app.get("/groups/new", (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const today = ymdOf(now(), u.tz);
    const v: V.GroupFormValues = { title: "", days: 0, hours: 1, minutes: 0, rangeStart: today, rangeEnd: addDays(today, 6), address: "", expiresOn: addDays(today, 13), tz: u.tz };
    return render(c, <V.GroupFormPage {...base(c)} mode="new" v={v} zones={zones()} now={now()} />);
  });

  app.post("/groups", async (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const r = parseGroupForm(await form(c));
    if (!r.ok) return render(c, <V.GroupFormPage {...base(c)} mode="new" v={r.v} error={r.error} zones={zones()} now={now()} />, 400);
    if (store.countOrganized(u.id) >= MAX_GROUPS) return render(c, <V.GroupFormPage {...base(c)} mode="new" v={r.v} error="err_too_many" zones={zones()} now={now()} />, 400);
    const g: Group = {
      id: newId(), invite: newId(), title: r.v.title, address: r.v.address, durationMin: r.durationMin, rangeStart: r.v.rangeStart,
      rangeEnd: r.v.rangeEnd, tz: r.v.tz, expiresOn: r.v.expiresOn, expiresAt: r.expiresAt, organizerId: u.id, confirmedId: null,
      seq: 0, rev: 1, createdAt: now(),
    };
    store.createGroup(g, { groupId: g.id, userId: u.id, joinedAt: now(), feedToken: newId() + newId(), calendars: null, marks: [] });
    return c.redirect(`/groups/${g.id}`, 303);
  });

  /** The group, if the signed-in user is a member. */
  const memberGroup = (c: C): { u: User; g: Group } | null => {
    const u = c.var.user;
    const g = u ? store.getGroup(c.req.param("id") ?? "") : null;
    if (!u || !g || g.expiresAt <= now() || !store.getMember(g.id, u.id)) return null;
    return { u, g };
  };

  app.get("/groups/:id", (c) => {
    if (!c.var.user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 303);
    const mg = memberGroup(c);
    if (!mg) return notFound(c);
    refreshGroupCalendars(o, mg.g);
    return render(c, <V.GroupPage {...base(c)} title={mg.g.title} boot={{ state: groupState(o, mg.g, mg.u), zones: zones() }} />);
  });

  app.get("/groups/:id/edit", (c) => {
    const mg = memberGroup(c);
    if (!mg || mg.g.organizerId !== mg.u.id) return notFound(c);
    const g = mg.g;
    const v: V.GroupFormValues = {
      title: g.title, days: Math.floor(g.durationMin / 1440), hours: Math.floor((g.durationMin % 1440) / 60), minutes: g.durationMin % 60,
      rangeStart: g.rangeStart, rangeEnd: g.rangeEnd, address: g.address, expiresOn: g.expiresOn, tz: g.tz,
    };
    return render(c, <V.GroupFormPage {...base(c)} mode="edit" groupId={g.id} v={v} zones={zones()} now={now()} />);
  });

  app.post("/groups/:id/edit", async (c) => {
    const mg = memberGroup(c);
    if (!mg || mg.g.organizerId !== mg.u.id) return notFound(c);
    const r = parseGroupForm(await form(c), mg.g.tz);
    if (!r.ok) return render(c, <V.GroupFormPage {...base(c)} mode="edit" groupId={mg.g.id} v={r.v} error={r.error} zones={zones()} now={now()} />, 400);
    store.updateGroup(mg.g.id, {
      title: r.v.title, address: r.v.address, durationMin: r.durationMin, rangeStart: r.v.rangeStart, rangeEnd: r.v.rangeEnd,
      expiresOn: r.v.expiresOn, expiresAt: r.expiresAt,
    });
    return c.redirect(`/groups/${mg.g.id}`, 303);
  });

  app.post("/groups/:id/delete", (c) => {
    const mg = memberGroup(c);
    if (!mg || mg.g.organizerId !== mg.u.id) return notFound(c);
    cancelIfUpcoming(mg.g);
    store.deleteGroup(mg.g.id);
    return c.redirect("/", 303);
  });

  app.post("/groups/:id/invite/reset", (c) => {
    const mg = memberGroup(c);
    if (!mg || mg.g.organizerId !== mg.u.id) return notFound(c);
    store.updateGroup(mg.g.id, { invite: newId() });
    return c.redirect(`/groups/${mg.g.id}`, 303);
  });

  app.get("/groups/:id/meeting.ics", (c) => {
    const mg = memberGroup(c);
    const p = mg?.g.confirmedId ? store.getProposal(mg.g.confirmedId) : null;
    if (!mg || !p) return notFound(c);
    c.header("Content-Disposition", 'attachment; filename="meeting.ics"');
    c.header("Cache-Control", "no-store");
    return c.body(buildEventIcs(meetingEvent(o, mg.g, p, "CONFIRMED"), "PUBLISH", now()), 200, { "Content-Type": "text/calendar; charset=utf-8" });
  });

  const invitePage = (c: C, g: Group, email?: string, error?: string | null) => {
    const organizer = store.getUser(g.organizerId);
    const members = store.countMembers(g.id);
    return (
      <V.InvitePage {...base(c)} group={g} organizer={organizer ? displayName(organizer) : "?"} members={members}
        isMember={false} full={members >= MAX_MEMBERS} email={email} error={error} />
    );
  };

  app.get("/g/:invite", (c) => {
    const g = store.getGroupByInvite(c.req.param("invite"));
    if (!g || g.expiresAt <= now()) return render(c, <V.Message {...base(c)} title={tt(c, "notfound_title")} text={tt(c, "invite_missing")} />, 404);
    const u = c.var.user;
    if (u && store.getMember(g.id, u.id)) return c.redirect(`/groups/${g.id}`, 303);
    return render(c, invitePage(c, g));
  });

  app.post("/g/:invite/join", (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const g = store.getGroupByInvite(c.req.param("invite"));
    if (!g || g.expiresAt <= now()) return render(c, <V.Message {...base(c)} title={tt(c, "notfound_title")} text={tt(c, "invite_missing")} />, 404);
    const r = join(o, g, u);
    if (!r.ok) return render(c, <V.Message {...base(c)} title={g.title} text={tt(c, "invite_full")} />, 409);
    const dest = `/groups/${g.id}`;
    return c.redirect(u.name ? dest : `/welcome?next=${encodeURIComponent(dest)}`, 303);
  });

  app.get("/feed/:file{[A-Za-z0-9_-]+\\.ics}", (c) => {
    const token = c.req.param("file").replace(/\.ics$/, "");
    const m = store.memberByFeedToken(token);
    const g = m ? store.getGroup(m.groupId) : null;
    if (!m || !g || g.expiresAt <= now()) return c.text("not found", 404);
    c.header("Cache-Control", "private, no-store");
    return c.body(feedFor(o, g), 200, { "Content-Type": "text/calendar; charset=utf-8" });
  });

  /* ---------- groups: JSON API for the group page ---------- */

  const apiGroup = (c: C) => {
    const mg = memberGroup(c);
    return mg;
  };
  const reply = (c: C, mg: { u: User; g: Group }, r: Result) => {
    if (!r.ok) return c.json({ error: r.error }, (r.status ?? 400) as 400);
    const fresh = store.getGroup(mg.g.id);
    if (!fresh) return c.json({ gone: true });
    return c.json({ changed: true, state: groupState(o, fresh, store.getUser(mg.u.id)!) });
  };
  const body = async (c: C): Promise<Record<string, unknown>> => {
    try { const b = await c.req.json(); return b && typeof b === "object" ? b as Record<string, unknown> : {}; } catch { return {}; }
  };

  app.get("/api/groups/:id", (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    if (Number(c.req.query("since")) === mg.g.rev) return c.json({ changed: false, rev: mg.g.rev });
    return c.json({ changed: true, state: groupState(o, mg.g, mg.u) });
  });

  const Stroke = z.object({ start: z.number().finite(), end: z.number().finite(), state: z.enum(["free", "busy", "clear"]) });

  app.post("/api/groups/:id/marks", async (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    const p = z.object({ strokes: z.array(Stroke).max(200) }).safeParse(await body(c));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return reply(c, mg, paint(o, mg.g, mg.u.id, p.data.strokes));
  });

  app.post("/api/groups/:id/marks/clear", (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    return reply(c, mg, clearMarks(o, mg.g, mg.u.id));
  });

  app.put("/api/groups/:id/calendars", async (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    const p = z.object({ ids: z.array(z.string().max(40)).max(MAX_CONNECTIONS).nullable() }).safeParse(await body(c));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return reply(c, mg, setMyCalendars(o, mg.g, mg.u.id, p.data.ids));
  });

  app.post("/api/groups/:id/proposals", async (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    const p = z.object({ start: z.number().finite() }).safeParse(await body(c));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return reply(c, mg, propose(o, mg.g, mg.u.id, p.data.start));
  });

  app.post("/api/groups/:id/proposals/:pid/withdraw", (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    return reply(c, mg, withdraw(o, mg.g, mg.u.id, c.req.param("pid")));
  });

  app.put("/api/groups/:id/proposals/:pid/votes/:uid", async (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    const p = z.object({ vote: z.enum(["yes", "no"]).nullable() }).safeParse(await body(c));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return reply(c, mg, vote(o, mg.g, mg.u.id, c.req.param("pid"), c.req.param("uid"), p.data.vote === null ? null : p.data.vote === "yes"));
  });

  app.post("/api/groups/:id/cancel", (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    return reply(c, mg, cancelMeeting(o, mg.g, mg.u.id));
  });

  app.post("/api/groups/:id/members/:uid/remove", (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    const r = removeMember(o, mg.g, mg.u.id, c.req.param("uid"));
    if (r.ok && c.req.param("uid") === mg.u.id) return c.json({ gone: true });
    return reply(c, mg, r);
  });

  app.post("/api/groups/:id/sync", (c) => {
    const mg = apiGroup(c);
    if (!mg) return c.json({ error: "not_found" }, 404);
    const m = store.getMember(mg.g.id, mg.u.id)!;
    o.syncer.kick(usedConnections(m, store.connectionsOfUser(mg.u.id)), 30_000);
    return reply(c, mg, { ok: true });
  });

  /* ---------- calendars ---------- */

  const calendarsPage = (c: C, u: User, extra: { error?: string | null; flash?: string | null } = {}, status = 200) =>
    render(c, <V.CalendarsPage {...base(c)} conns={store.connectionsOfUser(u.id)} providers={{ google: !!o.apps.google, microsoft: !!o.apps.microsoft }}
      back={safeBack(c.req.query("back"))} now={now()} {...extra} />, status);

  app.get("/calendars", (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    return calendarsPage(c, u);
  });

  const afterConnect = (c: C, conn: Connection) => {
    // The first sync runs in the background; the page shows "syncing…" until it lands.
    void o.syncer.sync(conn.id);
    store.bumpRevForUser(conn.userId);
    const back = safeBack(c.req.query("back"));
    return c.redirect(`/calendars/${conn.id}?ok=1${back ? `&back=${encodeURIComponent(back)}` : ""}`, 303);
  };

  const canConnect = (c: C, u: User): string | null => {
    if (store.connectionsOfUser(u.id).length >= MAX_CONNECTIONS) return "failed";
    if (!connectLimiter.allow(u.id) || !connectLimiter.allow(clientIp(c))) return "failed";
    return null;
  };

  app.post("/calendars/caldav", async (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const blocked = canConnect(c, u);
    if (blocked) return calendarsPage(c, u, { error: blocked }, 429);
    const f = await form(c);
    const provider = str(f.provider);
    const username = str(f.username).trim().slice(0, 200), password = str(f.password).slice(0, 200);
    let url: string;
    try {
      url = provider in CALDAV_PROVIDERS ? CALDAV_PROVIDERS[provider as keyof typeof CALDAV_PROVIDERS] : parseUserUrl(str(f.url)).toString();
    } catch { return calendarsPage(c, u, { error: "bad_url" }, 400); }
    if (!username || !password) return calendarsPage(c, u, { error: "auth" }, 400);
    let cals;
    try {
      cals = await discoverCalendars(url, username, password, o.guard);
    } catch (e) {
      return calendarsPage(c, u, { error: e instanceof FetchError ? e.code : "failed" }, 400);
    }
    const name = provider === "icloud" ? "iCloud" : provider === "yandex" ? "Яндекс" : provider === "fastmail" ? "Fastmail" : new URL(url).hostname;
    const secret: CaldavSecret = { url, username, password, calendars: cals.map((x) => ({ href: x.href, name: x.name, selected: true })) };
    const conn: Connection = {
      id: newId(), userId: u.id, kind: "caldav", label: `${name} · ${username}`.slice(0, 60), secret: o.sealer.seal(secret),
      status: "new", error: null, syncedAt: null, createdAt: now(),
    };
    store.createConnection(conn);
    return afterConnect(c, conn);
  });

  app.post("/calendars/ics", async (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const blocked = canConnect(c, u);
    if (blocked) return calendarsPage(c, u, { error: blocked }, 429);
    const f = await form(c);
    let url: string;
    try { url = normalizeIcsUrl(str(f.url)); } catch { return calendarsPage(c, u, { error: "bad_url" }, 400); }
    try {
      await icsBusy({ url }, now(), now() + DAY, u.tz, o.guard);
    } catch (e) {
      return calendarsPage(c, u, { error: e instanceof FetchError ? e.code : "failed" }, 400);
    }
    const label = str(f.label).trim().slice(0, 60) || new URL(url).hostname;
    const conn: Connection = {
      id: newId(), userId: u.id, kind: "ics", label, secret: o.sealer.seal({ url }), status: "new", error: null, syncedAt: null, createdAt: now(),
    };
    store.createConnection(conn);
    return afterConnect(c, conn);
  });

  const ownConnection = (c: C): { u: User; conn: Connection } | null => {
    const u = c.var.user;
    const conn = u ? store.getConnection(c.req.param("id") ?? "") : null;
    return u && conn && conn.userId === u.id ? { u, conn } : null;
  };

  const calendarList = (conn: Connection): { id: string; name: string; selected: boolean }[] | null => {
    if (conn.kind === "caldav") return o.sealer.open<CaldavSecret>(conn.secret).calendars.map((x) => ({ id: x.href, name: x.name, selected: x.selected }));
    if (conn.kind === "google" || conn.kind === "microsoft") return o.sealer.open<OAuthSecret>(conn.secret).calendars;
    return null;
  };

  app.get("/calendars/:id", (c) => {
    if (!c.var.user) return c.redirect("/login", 303);
    const oc = ownConnection(c);
    if (!oc) return notFound(c);
    return render(c, <V.ConnectionPage {...base(c)} conn={oc.conn} calendars={calendarList(oc.conn)} back={safeBack(c.req.query("back"))}
      flash={c.req.query("ok") === "1" ? "cal_connected" : c.req.query("saved") === "1" ? "saved" : null} now={now()} />);
  });

  app.post("/calendars/:id", async (c) => {
    const oc = ownConnection(c);
    if (!oc) return notFound(c);
    const f = await form(c);
    const label = str(f.label).trim().slice(0, 60) || oc.conn.label;
    const picked = new Set(Array.isArray(f.cal) ? f.cal : f.cal ? [f.cal] : []);
    let secret = oc.conn.secret;
    if (oc.conn.kind === "caldav") {
      const s = o.sealer.open<CaldavSecret>(secret);
      secret = o.sealer.seal({ ...s, calendars: s.calendars.map((x) => ({ ...x, selected: picked.has(x.href) })) });
    } else if (oc.conn.kind === "google" || oc.conn.kind === "microsoft") {
      const s = o.sealer.open<OAuthSecret>(secret);
      secret = o.sealer.seal({ ...s, calendars: s.calendars.map((x) => ({ ...x, selected: picked.has(x.id) })) });
    }
    store.updateConnection(oc.conn.id, { label, secret, syncedAt: null });
    void o.syncer.sync(oc.conn.id);
    const back = safeBack(c.req.query("back"));
    return c.redirect(`/calendars/${oc.conn.id}?saved=1${back ? `&back=${encodeURIComponent(back)}` : ""}`, 303);
  });

  app.post("/calendars/:id/delete", (c) => {
    const oc = ownConnection(c);
    if (!oc) return notFound(c);
    store.deleteConnection(oc.conn.id);
    const back = safeBack(c.req.query("back"));
    return c.redirect(`/calendars${back ? `?back=${encodeURIComponent(back)}` : ""}`, 303);
  });

  app.post("/calendars/:id/sync", async (c) => {
    const oc = ownConnection(c);
    if (!oc) return notFound(c);
    await Promise.race([o.syncer.sync(oc.conn.id), new Promise((r) => setTimeout(r, 15_000))]);
    const back = safeBack(c.req.query("back"));
    return c.redirect(`/calendars${back ? `?back=${encodeURIComponent(back)}` : ""}`, 303);
  });

  /* ---------- OAuth (Google, Microsoft) ---------- */

  const provider = (c: C): Provider | null => {
    const p = c.req.param("provider");
    return p === "google" || p === "microsoft" ? p : null;
  };

  app.get("/oauth/:provider/start", (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const p = provider(c);
    const appCfg = p ? o.apps[p] : undefined;
    if (!p || !appCfg) return notFound(c);
    if (canConnect(c, u)) return calendarsPage(c, u, { error: "failed" }, 429);
    const state = newToken(), verifier = newToken(48);
    store.createOAuthState({ hash: sha256(state), userId: u.id, provider: p, verifier, back: safeBack(c.req.query("back")) ?? null, expiresAt: now() + 15 * 60_000 });
    return c.redirect(authUrl(p, appCfg, state, pkceChallenge(verifier)), 302);
  });

  app.get("/oauth/:provider/callback", async (c) => {
    const u = requireUser(c);
    if (u instanceof Response) return u;
    const p = provider(c);
    const appCfg = p ? o.apps[p] : undefined;
    if (!p || !appCfg) return notFound(c);
    const st = store.takeOAuthState(sha256(c.req.query("state") ?? ""), now());
    if (!st || st.userId !== u.id || st.provider !== p) return calendarsPage(c, u, { error: "failed" }, 400);
    const backQ = st.back ? `?back=${encodeURIComponent(st.back)}` : "";
    if (c.req.query("error") || !c.req.query("code")) return c.redirect(`/calendars${backQ}`, 303);
    try {
      const tok = await exchangeCode(p, appCfg, c.req.query("code")!, st.verifier);
      if (!tok.refreshToken) throw new FetchError("auth");
      const cals = await listCalendars(p, tok.accessToken);
      const secret: OAuthSecret = {
        refreshToken: tok.refreshToken, email: tok.email,
        calendars: cals.map((x, i) => ({ id: x.id, name: x.name, selected: x.primary || (i === 0 && !cals.some((y) => y.primary)) })),
      };
      const conn: Connection = {
        id: newId(), userId: u.id, kind: p, label: `${p === "google" ? "Google" : "Outlook"}${tok.email ? ` · ${tok.email}` : ""}`.slice(0, 60),
        secret: o.sealer.seal(secret), status: "new", error: null, syncedAt: null, createdAt: now(),
      };
      store.createConnection(conn);
      void o.syncer.sync(conn.id);
      store.bumpRevForUser(u.id);
      return c.redirect(`/calendars/${conn.id}?ok=1${st.back ? `&back=${encodeURIComponent(st.back)}` : ""}`, 303);
    } catch (e) {
      o.log(`oauth ${p} failed: ${e instanceof FetchError ? e.code : String((e as Error)?.message ?? e).slice(0, 200)}`);
      return calendarsPage(c, u, { error: e instanceof FetchError ? e.code : "failed" }, 400);
    }
  });

  app.notFound((c) => notFound(c as C));
  app.onError((e, c) => {
    o.log(`error ${c.req.method} ${c.req.path}: ${String((e as Error)?.stack ?? e).slice(0, 500)}`);
    return c.text("internal error", 500);
  });

  return app;
}
