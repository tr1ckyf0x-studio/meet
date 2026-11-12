import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createApp } from "../server/app";
import { Syncer } from "../server/calendars/sync";
import { Sealer } from "../server/crypto";
import { Store } from "../server/db";
import { MemoryMailer } from "../server/mail";
import { defaultLimits } from "../server/meeting";

export const ORIGIN = "https://meet.test";
let now = Date.UTC(2026, 10, 12, 10);
export const clock = () => now;
export const setClock = (t: number) => { now = t; };

export function setup() {
  const store = new Store(":memory:");
  const sealer = new Sealer(randomBytes(32));
  const mailer = new MemoryMailer();
  const syncer = new Syncer({ store, sealer, guard: {}, apps: {}, now: clock });
  const logs: string[] = [];
  const app = createApp({
    store, sealer, mailer, syncer, publicUrl: ORIGIN, now: clock, ...defaultLimits(clock), organizerEmail: "noreply@meet.test", log: (m) => logs.push(m), apps: {}, guard: {},
    signupCode: "letmein", secureCookies: false, revision: "test", assets: new Map([["style.css", ["text/css", "x"]]]),
  });
  return { store, mailer, app, logs };
}

export type App = ReturnType<typeof setup>["app"];

export class Browser {
  cookie = "";
  constructor(private readonly app: App) {}
  async req(method: string, path: string, body?: Record<string, string> | object, json = false): Promise<Response> {
    const headers: Record<string, string> = { origin: ORIGIN, host: "meet.test" };
    if (this.cookie) headers.cookie = this.cookie;
    let b: string | undefined;
    if (body && json) { headers["content-type"] = "application/json"; b = JSON.stringify(body); }
    else if (body) { headers["content-type"] = "application/x-www-form-urlencoded"; b = new URLSearchParams(body as Record<string, string>).toString(); }
    const r = await this.app.request(`${ORIGIN}${path}`, { method, headers, body: b });
    const set = r.headers.get("set-cookie");
    if (set && /sid=/.test(set)) this.cookie = set.split(";")[0]!;
    return r;
  }
  get(p: string) { return this.req("GET", p); }
  post(p: string, body: Record<string, string> = {}) { return this.req("POST", p, body); }
  api(method: string, p: string, body: object = {}) { return this.req(method, p, body, true); }
}

export const linkFrom = (mailer: MemoryMailer) => /\/auth\?t=([\w-]+)/.exec(mailer.sent.at(-1)!.text)![1]!;

export async function signIn(env: ReturnType<typeof setup>, email: string, extra: Record<string, string>, name: string): Promise<Browser> {
  const b = new Browser(env.app);
  const before = env.mailer.sent.length;
  await b.post("/login", { email, ...extra });
  expect(env.mailer.sent.length).toBe(before + 1);
  const r = await b.post("/auth", { t: linkFrom(env.mailer) });
  expect(r.status).toBe(303);
  if (r.headers.get("location")!.startsWith("/welcome")) {
    const next = new URL(r.headers.get("location")!, ORIGIN).searchParams.get("next")!;
    await b.post("/welcome", { name, tz: "Europe/Belgrade", lang: "ru", next });
  }
  return b;
}

export async function createGroup(b: Browser, title = "Ужин"): Promise<string> {
  const r = await b.post("/groups", {
    title, days: "0", hours: "2", minutes: "0", rangeStart: "2026-11-13", rangeEnd: "2026-11-15", address: "Белград", expiresOn: "2026-11-20", tz: "Europe/Belgrade",
  });
  expect(r.status).toBe(303);
  return r.headers.get("location")!.split("/").pop()!;
}

