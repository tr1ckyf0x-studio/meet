import type { Context } from "hono";
import { isIP } from "node:net";

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4/, /ips-v6/).
const CF_V4: [string, number][] = [
  ["173.245.48.0", 20], ["103.21.244.0", 22], ["103.22.200.0", 22], ["103.31.4.0", 22], ["141.101.64.0", 18],
  ["108.162.192.0", 18], ["190.93.240.0", 20], ["188.114.96.0", 20], ["197.234.240.0", 22], ["198.41.128.0", 17],
  ["162.158.0.0", 15], ["104.16.0.0", 13], ["104.24.0.0", 14], ["172.64.0.0", 13], ["131.0.72.0", 22],
];
const CF_V6 = ["2400:cb00:", "2606:4700:", "2803:f800:", "2405:b500:", "2405:8100:", "2a06:98c", "2a06:98d", "2a06:98e", "2a06:98f", "2c0f:f248:"];

const v4 = (ip: string) => ip.split(".").reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;

export function isCloudflare(ip: string): boolean {
  if (isIP(ip) === 4) return CF_V4.some(([b, bits]) => v4(ip) >>> (32 - bits) === v4(b) >>> (32 - bits));
  if (isIP(ip) === 6) return CF_V6.some((p) => ip.toLowerCase().startsWith(p));
  return false;
}

/**
 * The client's address. Traefik trusts no forwarded headers, so the last X-Forwarded-For entry is the peer it saw.
 * Only when that peer is a Cloudflare edge is Cloudflare's CF-Connecting-IP believed; anyone reaching the origin
 * directly could put anything into that header.
 */
export function clientIp(c: Context): string {
  const peer = c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || "local";
  if (isCloudflare(peer)) return c.req.header("cf-connecting-ip")?.trim() || peer;
  return peer;
}

/** Same-origin check for state-changing requests: the browser's Origin must name the host it is talking to. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  const host = c.req.header("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
