import { XMLParser } from "fast-xml-parser";
import { normalize, type Iv } from "../../shared/intervals";
import { FetchError, safeFetch, sameSite, type GuardOptions } from "./fetchguard";
import { busyFromIcs } from "./parse";
import { icsDate } from "../ics";

// A small CalDAV client: discovery (RFC 6764/4791) and a time-range calendar-query. Works with iCloud,
// Yandex, Fastmail, Nextcloud, Radicale and others that speak plain CalDAV with an app password.

export const CALDAV_PROVIDERS = {
  icloud: "https://caldav.icloud.com/",
  yandex: "https://caldav.yandex.ru/",
  fastmail: "https://caldav.fastmail.com/dav/",
} as const;
export type CaldavProvider = keyof typeof CALDAV_PROVIDERS | "other";

export interface CaldavSecret {
  url: string;
  username: string;
  password: string;
  calendars: { href: string; name: string; selected: boolean }[];
}

export interface CaldavCalendar { href: string; name: string }

const xml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "response" || name === "propstat" || name === "comp" || name === "href",
});

type Node = Record<string, unknown>;

interface DavResponse { href: string; props: Node }

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as Node)) return String((v as Node)["#text"]);
  return "";
}

function parseMultistatus(body: string): DavResponse[] {
  let doc: Node;
  try { doc = xml.parse(body) as Node; } catch { throw new FetchError("bad_dav_response"); }
  const ms = doc.multistatus as Node | undefined;
  if (!ms) throw new FetchError("bad_dav_response");
  const out: DavResponse[] = [];
  for (const r of (ms.response as Node[] | undefined) ?? []) {
    const href = text((r.href as unknown[] | undefined)?.[0]);
    const props: Node = {};
    for (const ps of (r.propstat as Node[] | undefined) ?? []) {
      if (!/\s2\d\d\s/.test(` ${text(ps.status)} `)) continue;
      Object.assign(props, (ps.prop as Node | undefined) ?? {});
    }
    out.push({ href, props });
  }
  return out;
}

function hrefIn(prop: unknown): string | null {
  if (!prop || typeof prop !== "object") return null;
  const h = (prop as Node).href as unknown[] | undefined;
  return h?.length ? text(h[0]) || null : null;
}

class DavClient {
  private readonly auth: string;
  constructor(private readonly base: URL, username: string, password: string, private readonly guard: GuardOptions) {
    this.auth = "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  }

  async request(method: string, url: string, depth: "0" | "1", body: string): Promise<{ url: string; responses: DavResponse[] }> {
    const target = new URL(url);
    const headers: Record<string, string> = { "content-type": "application/xml; charset=utf-8", depth, "user-agent": "meet-calendar/1" };
    // Credentials go only to the provider's own hosts (iCloud spreads accounts over pNN-caldav.icloud.com).
    if (sameSite(this.base, target)) headers.authorization = this.auth;
    const r = await safeFetch(url, { method, headers, body }, this.guard);
    if (r.status === 401 || r.status === 403) throw new FetchError("auth");
    if (r.status === 404) throw new FetchError("not_found");
    if (r.status !== 207) throw new FetchError(`http_${r.status}`);
    return { url: r.url, responses: parseMultistatus(r.text) };
  }
}

const PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const HOME = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const LIST = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>`;

function listCalendars(base: string, responses: DavResponse[], self: string): CaldavCalendar[] {
  const out: CaldavCalendar[] = [];
  for (const r of responses) {
    const rt = r.props.resourcetype as Node | undefined;
    if (!rt || typeof rt !== "object" || !("calendar" in rt)) continue;
    const comps = ((r.props["supported-calendar-component-set"] as Node | undefined)?.comp as Node[] | undefined) ?? [];
    if (comps.length && !comps.some((c) => String(c["@_name"]).toUpperCase() === "VEVENT")) continue;
    const href = new URL(r.href, base).toString();
    if (href === self) continue;
    out.push({ href, name: text(r.props.displayname) || decodeURIComponent(new URL(href).pathname.split("/").filter(Boolean).pop() ?? "calendar") });
  }
  return out;
}

/** Finds the user's event calendars starting from a server URL (or a principal or calendar-home URL). */
export async function discoverCalendars(url: string, username: string, password: string, guard: GuardOptions): Promise<CaldavCalendar[]> {
  const base = new URL(url);
  const dav = new DavClient(base, username, password, guard);

  let principal: string | null = null;
  let principalBase = url;
  for (const candidate of [url, new URL("/.well-known/caldav", base).toString()]) {
    try {
      const r = await dav.request("PROPFIND", candidate, "0", PRINCIPAL);
      const href = r.responses.map((x) => hrefIn(x.props["current-user-principal"])).find(Boolean);
      if (href) { principal = new URL(href, r.url).toString(); principalBase = r.url; break; }
    } catch (e) {
      if (e instanceof FetchError && (e.code === "auth" || e.code === "private_address" || e.code === "dns")) throw e;
    }
  }

  const homes: string[] = [];
  if (principal) {
    const r = await dav.request("PROPFIND", principal, "0", HOME);
    for (const x of r.responses) {
      const h = hrefIn(x.props["calendar-home-set"]);
      if (h) homes.push(new URL(h, r.url).toString());
    }
  }
  if (!homes.length) homes.push(principal ?? principalBase);

  for (const home of homes) {
    const r = await dav.request("PROPFIND", home, "1", LIST);
    const cals = listCalendars(r.url, r.responses, new URL(home).toString());
    if (cals.length) return cals;
  }
  // The URL may be a single calendar collection.
  const r = await dav.request("PROPFIND", url, "0", LIST);
  const single = listCalendars(r.url, r.responses, "");
  if (single.length) return single;
  throw new FetchError("no_calendars");
}

function queryBody(lo: number, hi: number): string {
  return `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
    `<c:time-range start="${icsDate(lo)}" end="${icsDate(hi)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

/** Busy time from the selected calendars. */
export async function caldavBusy(secret: CaldavSecret, lo: number, hi: number, tz: string, guard: GuardOptions): Promise<Iv[]> {
  const dav = new DavClient(new URL(secret.url), secret.username, secret.password, guard);
  const out: Iv[] = [];
  for (const cal of secret.calendars.filter((c) => c.selected)) {
    const r = await dav.request("REPORT", cal.href, "1", queryBody(lo, hi));
    for (const x of r.responses) {
      const data = text(x.props["calendar-data"]);
      if (!data.includes("BEGIN:VCALENDAR")) continue;
      try { out.push(...busyFromIcs(data, lo, hi, tz)); } catch { /* one broken event does not spoil the rest */ }
    }
  }
  return normalize(out);
}
