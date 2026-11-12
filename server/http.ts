import type { Context } from "hono";

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/** Same-origin check for state-changing requests: the browser's Origin must name the host it is talking to. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  const host = c.req.header("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
