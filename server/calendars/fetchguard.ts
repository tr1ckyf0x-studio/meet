import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { gunzipSync, inflateSync } from "node:zlib";

// Users give us URLs (ICS links, CalDAV servers) that the server then fetches. Without a guard that is a
// way into the home network: the router, Komodo, other containers. Every hop must resolve to public
// addresses only. (DNS could still change between our lookup and fetch's own; the window is small.)

export class FetchError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Private(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
}

/** Eight 16-bit groups of an IPv6 address (an embedded dotted IPv4 tail included). */
function v6Groups(ip: string): number[] | null {
  let a = ip.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    a = a.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(Math.max(fill, 0)).fill("0"), ...t];
  if (all.length !== 8) return null;
  return all.map((g) => parseInt(g || "0", 16));
}

/** True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  const v4tail = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && g[7] === 1) return true; // ::1
  if (zeros(5) && g[5] === 0xffff) return v4Private(v4tail()); // ::ffff:a.b.c.d mapped
  if (zeros(6)) return v4Private(v4tail()); // ::a.b.c.d compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(v4tail()); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4 (embeds an IPv4 address)
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return false;
}

export interface GuardOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Development and tests only: skip the address check entirely. */
  allowPrivate?: boolean;
  /** Tests only: host names exempt from the check. */
  allowHosts?: string[];
  /** Host names (and their subdomains) never fetched, e.g. the operator's own zone. */
  denySuffixes?: string[];
  /** Host names whose current addresses are never connected to, e.g. a dynamic DNS name of the home WAN address:
   *  a public address that loops back into the operator's network through hairpin NAT. */
  denyAddressesOf?: string[];
}

export interface FetchResult { status: number; url: string; headers: Headers; text: string }

const denyCache = new Map<string, { at: number; ips: string[] }>();
async function deniedAddresses(o: GuardOptions): Promise<Set<string>> {
  const out = new Set<string>();
  for (const name of o.denyAddressesOf ?? []) {
    let e = denyCache.get(name);
    if (!e || Date.now() - e.at > 5 * 60_000) {
      const ips = await lookup(name, { all: true, verbatim: true }).then((r) => r.map((x) => x.address), () => e?.ips ?? []);
      e = { at: Date.now(), ips };
      denyCache.set(name, e);
    }
    for (const ip of e.ips) out.add(ip);
  }
  return out;
}

/** Checks a host before connecting. IP literals are checked here: node:http does not call `lookup` for them. */
async function checkTarget(host: string, o: GuardOptions): Promise<void> {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (o.denySuffixes?.some((d) => h === d || h.endsWith("." + d))) throw new FetchError("private_address");
  if (isIP(h)) return checkAddresses(h, [h], o);
  if (o.allowPrivate || o.allowHosts?.includes(h)) return;
  if (!h.includes(".") || /\.(local|internal|lan|home|localhost|home\.arpa)$/i.test(h)) throw new FetchError("private_address");
}

async function checkAddresses(host: string, addrs: string[], o: GuardOptions): Promise<void> {
  if (!addrs.length) throw new FetchError("dns");
  const denied = await deniedAddresses(o);
  if (addrs.some((a) => denied.has(a))) throw new FetchError("private_address");
  if (o.allowPrivate || o.allowHosts?.includes(host)) return;
  if (addrs.some(isPrivateAddress)) throw new FetchError("private_address");
}

/**
 * A DNS lookup for node:http that checks every address it returns. The connection then goes to exactly the
 * checked address, so a name cannot answer "public" to the check and "private" to the connect (DNS rebinding).
 */
function guardedLookup(o: GuardOptions) {
  return (hostname: string, options: { all?: boolean } | number | undefined, cb: (...a: unknown[]) => void) => {
    const host = hostname.replace(/^\[|\]$/g, "");
    const done = (addrs: { address: string; family: number }[]) => {
      checkAddresses(host, addrs.map((a) => a.address), o).then(() => {
        if (typeof options === "object" && options?.all) cb(null, addrs);
        else cb(null, addrs[0]!.address, addrs[0]!.family);
      }, (e) => cb(e));
    };
    if (isIP(host)) return done([{ address: host, family: isIP(host) }]);
    lookup(host, { all: true, verbatim: true }).then(done, () => cb(new FetchError("dns")));
  };
}

/** Same host, or the same last two labels (caldav.icloud.com -> p42-caldav.icloud.com). */
export function sameSite(a: URL, b: URL): boolean {
  if (a.hostname === b.hostname) return true;
  if (isIP(a.hostname.replace(/^\[|\]$/g, "")) || isIP(b.hostname.replace(/^\[|\]$/g, ""))) return false;
  const tail = (h: string) => h.split(".").slice(-2).join(".");
  return tail(a.hostname) === tail(b.hostname);
}

export function parseUserUrl(input: string): URL {
  let s = input.trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, "https://");
  let u: URL;
  try { u = new URL(s); } catch { throw new FetchError("bad_url"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FetchError("bad_url");
  if (u.username || u.password) throw new FetchError("bad_url");
  return u;
}

interface RawResponse { status: number; headers: Headers; body: Buffer }

function rawRequest(url: URL, method: string, headers: Headers, body: string | undefined, o: GuardOptions, signal: AbortSignal, maxBytes: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const h: Record<string, string> = {};
    headers.forEach((v, k) => { h[k] = v; });
    if (body !== undefined) h["content-length"] = String(Buffer.byteLength(body));
    if (!h["accept-encoding"]) h["accept-encoding"] = "gzip, deflate";
    let failed = false;
    const fail = (e: unknown) => { if (!failed) { failed = true; reject(e); } };
    const req = mod.request(url, { method, headers: h, lookup: guardedLookup(o) as never, signal, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        if (failed) return;
        size += c.length;
        if (size > maxBytes) { fail(new FetchError("too_large")); req.destroy(); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        if (failed) return;
        let buf = Buffer.concat(chunks);
        try {
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          if (enc === "gzip") buf = gunzipSync(buf, { maxOutputLength: maxBytes });
          else if (enc === "deflate") buf = inflateSync(buf, { maxOutputLength: maxBytes });
        } catch { fail(new FetchError("too_large")); return; }
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        resolve({ status: res.statusCode ?? 0, headers: out, body: buf });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** fetch() for user-supplied URLs: public addresses only (every redirect re-checked), bounded size and time. */
export async function safeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, o: GuardOptions = {}): Promise<FetchResult> {
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 20_000);
  let current = parseUserUrl(url);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  const start = current;
  for (let hop = 0; ; hop++) {
    if (hop > (o.maxRedirects ?? 5)) throw new FetchError("too_many_redirects");
    await checkTarget(current.hostname.replace(/^\[|\]$/g, ""), o);
    let res: RawResponse;
    try {
      res = await rawRequest(current, method, headers, body, o, signal, maxBytes);
    } catch (e) {
      if (e instanceof FetchError) throw e;
      if (signal.aborted) throw new FetchError("timeout");
      throw new FetchError("network", String((e as Error)?.message ?? e));
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, current);
      if (next.protocol !== "https:" && next.protocol !== "http:") throw new FetchError("bad_url");
      if (!sameSite(start, next)) headers.delete("authorization");
      if (res.status === 303) { method = "GET"; body = undefined; }
      current = next;
      continue;
    }
    return { status: res.status, url: current.toString(), headers: res.headers, text: res.body.toString("utf8") };
  }
}
