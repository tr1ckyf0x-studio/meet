import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
}

export interface FetchResult { status: number; url: string; headers: Headers; text: string }

async function assertPublic(host: string, o: GuardOptions): Promise<void> {
  if (o.allowPrivate || o.allowHosts?.includes(host)) return;
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isPrivateAddress(bare)) throw new FetchError("private_address");
    return;
  }
  if (!bare.includes(".") || /\.(local|internal|lan|home|localhost)$/i.test(bare)) throw new FetchError("private_address");
  let addrs: { address: string }[];
  try {
    addrs = await lookup(bare, { all: true, verbatim: true });
  } catch {
    throw new FetchError("dns");
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new FetchError("private_address");
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

/** fetch() for user-supplied URLs: public addresses only (every redirect re-checked), bounded size and time. */
export async function safeFetch(url: string, init: RequestInit = {}, o: GuardOptions = {}): Promise<FetchResult> {
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 20_000);
  let current = parseUserUrl(url);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  const start = current;
  for (let hop = 0; ; hop++) {
    if (hop > (o.maxRedirects ?? 5)) throw new FetchError("too_many_redirects");
    await assertPublic(current.hostname, o);
    let res: Response;
    try {
      res = await fetch(current, { ...init, method, body, headers, redirect: "manual", signal });
    } catch (e) {
      if (signal.aborted) throw new FetchError("timeout");
      throw new FetchError("network", String((e as Error)?.message ?? e));
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      const next = new URL(loc, current);
      if (next.protocol !== "https:" && next.protocol !== "http:") throw new FetchError("bad_url");
      if (!sameSite(start, next)) headers.delete("authorization");
      if (res.status === 303) { method = "GET"; body = undefined; }
      current = next;
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        let r: { done: boolean; value?: Uint8Array };
        try { r = await reader.read(); } catch { throw new FetchError(signal.aborted ? "timeout" : "network"); }
        if (r.done || !r.value) break;
        size += r.value.length;
        if (size > maxBytes) { await reader.cancel(); throw new FetchError("too_large"); }
        chunks.push(r.value);
      }
    }
    return { status: res.status, url: current.toString(), headers: res.headers, text: Buffer.concat(chunks).toString("utf8") };
  }
}
