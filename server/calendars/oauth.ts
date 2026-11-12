import { normalize, type Iv } from "../../shared/intervals";
import { DAY } from "../../shared/time";
import { FetchError } from "./fetchguard";

// Google Calendar and Microsoft Graph. Both reduce to busy intervals: Google's FreeBusy API returns
// nothing else at all; for Graph we $select only start, end, showAs and isCancelled.

export interface OAuthApp { clientId: string; clientSecret: string; redirectUri: string }
export type Provider = "google" | "microsoft";

export interface OAuthSecret {
  refreshToken: string;
  email: string;
  calendars: { id: string; name: string; selected: boolean }[];
}

export interface Tokens { accessToken: string; refreshToken: string | null; email: string }

type F = typeof fetch;

const GOOGLE_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");
const MS_SCOPES = "offline_access openid email User.Read Calendars.ReadBasic";
const MS_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";

export function authUrl(p: Provider, app: OAuthApp, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: app.clientId, redirect_uri: app.redirectUri, response_type: "code", state,
    code_challenge: challenge, code_challenge_method: "S256",
  });
  if (p === "google") {
    q.set("scope", GOOGLE_SCOPES);
    q.set("access_type", "offline");
    q.set("prompt", "consent");
    q.set("include_granted_scopes", "true");
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  q.set("scope", MS_SCOPES);
  q.set("response_mode", "query");
  q.set("prompt", "select_account");
  return `${MS_BASE}/authorize?${q}`;
}

function jwtEmail(idToken: unknown): string {
  if (typeof idToken !== "string") return "";
  try {
    const p = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return String(p.email ?? p.preferred_username ?? "");
  } catch { return ""; }
}

async function tokenRequest(p: Provider, app: OAuthApp, form: Record<string, string>, f: F): Promise<Record<string, unknown>> {
  const url = p === "google" ? "https://oauth2.googleapis.com/token" : `${MS_BASE}/token`;
  const body = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...form });
  if (p === "microsoft") body.set("scope", MS_SCOPES);
  const r = await f(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(20_000) });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    if (j.error === "invalid_grant") throw new FetchError("auth");
    throw new FetchError(`oauth_${String(j.error ?? r.status)}`);
  }
  return j;
}

/** Trades the authorization code for tokens and learns the account's address. */
export async function exchangeCode(p: Provider, app: OAuthApp, code: string, verifier: string, f: F = fetch): Promise<Tokens> {
  const j = await tokenRequest(p, app, { code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: app.redirectUri }, f);
  const accessToken = String(j.access_token ?? "");
  let email = jwtEmail(j.id_token);
  if (!email && p === "microsoft") {
    const me = (await getJson(f, `${GRAPH}/me?$select=mail,userPrincipalName`, accessToken)) as Record<string, unknown>;
    email = String(me.mail ?? me.userPrincipalName ?? "");
  }
  return { accessToken, refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null, email };
}

/** A fresh access token. Microsoft rotates refresh tokens: the new one comes back in `refreshToken`. */
export async function refreshAccess(p: Provider, app: OAuthApp, refreshToken: string, f: F = fetch): Promise<Tokens> {
  const j = await tokenRequest(p, app, { refresh_token: refreshToken, grant_type: "refresh_token" }, f);
  return { accessToken: String(j.access_token ?? ""), refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null, email: "" };
}

async function getJson(f: F, url: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const r = await f(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (r.status === 401 || r.status === 403) throw new FetchError("auth");
  if (!r.ok) throw new FetchError(`http_${r.status}`);
  return r.json();
}

export async function listCalendars(p: Provider, accessToken: string, f: F = fetch): Promise<{ id: string; name: string; primary: boolean }[]> {
  const out: { id: string; name: string; primary: boolean }[] = [];
  if (p === "google") {
    let page: string | undefined;
    do {
      const q = new URLSearchParams({ minAccessRole: "freeBusyReader", maxResults: "250" });
      if (page) q.set("pageToken", page);
      const j = (await getJson(f, `https://www.googleapis.com/calendar/v3/users/me/calendarList?${q}`, accessToken)) as { items?: Record<string, unknown>[]; nextPageToken?: string };
      for (const c of j.items ?? []) out.push({ id: String(c.id), name: String(c.summaryOverride ?? c.summary ?? c.id), primary: c.primary === true });
      page = j.nextPageToken;
    } while (page);
    return out;
  }
  let url: string | undefined = `${GRAPH}/me/calendars?$select=id,name,isDefaultCalendar&$top=100`;
  while (url) {
    const j = (await getJson(f, url, accessToken)) as { value?: Record<string, unknown>[]; "@odata.nextLink"?: string };
    for (const c of j.value ?? []) out.push({ id: String(c.id), name: String(c.name ?? "Calendar"), primary: c.isDefaultCalendar === true });
    url = j["@odata.nextLink"];
  }
  return out;
}

/** Busy time of the selected calendars in [lo, hi). */
export async function providerBusy(p: Provider, accessToken: string, ids: string[], lo: number, hi: number, f: F = fetch): Promise<Iv[]> {
  const out: Iv[] = [];
  if (!ids.length) return out;
  if (p === "google") {
    // FreeBusy answers about at most 50 calendars and a limited span per request.
    for (let s = lo; s < hi; s += 60 * DAY) {
      const e = Math.min(hi, s + 60 * DAY);
      for (let i = 0; i < ids.length; i += 50) {
        const j = (await getJson(f, "https://www.googleapis.com/calendar/v3/freeBusy", accessToken, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ timeMin: new Date(s).toISOString(), timeMax: new Date(e).toISOString(), items: ids.slice(i, i + 50).map((id) => ({ id })) }),
        })) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
        for (const c of Object.values(j.calendars ?? {})) {
          for (const b of c.busy ?? []) out.push([Date.parse(b.start), Date.parse(b.end)]);
        }
      }
    }
    return normalize(out);
  }
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const id of ids) {
    let url: string | undefined = `${GRAPH}/me/calendars/${encodeURIComponent(id)}/calendarView?` +
      new URLSearchParams({ startDateTime: iso(lo), endDateTime: iso(hi), $select: "start,end,showAs,isCancelled", $top: "500" });
    for (let pages = 0; url && pages < 50; pages++) {
      const j = (await getJson(f, url, accessToken, { headers: { prefer: 'outlook.timezone="UTC"' } })) as {
        value?: { start?: { dateTime: string }; end?: { dateTime: string }; showAs?: string; isCancelled?: boolean }[];
        "@odata.nextLink"?: string;
      };
      for (const ev of j.value ?? []) {
        if (ev.isCancelled || ev.showAs === "free" || ev.showAs === "workingElsewhere") continue;
        if (!ev.start || !ev.end) continue;
        const s = Date.parse(ev.start.dateTime.slice(0, 23) + "Z"), e = Date.parse(ev.end.dateTime.slice(0, 23) + "Z");
        if (e > s) out.push([s, e]);
      }
      url = j["@odata.nextLink"];
    }
  }
  return normalize(out);
}
