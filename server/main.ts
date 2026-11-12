import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { createApp } from "./app";
import { Syncer } from "./calendars/sync";
import { loadKey, Sealer } from "./crypto";
import { Store } from "./db";
import { MemoryMailer, SmtpMailer, type Mailer } from "./mail";
import type { OAuthApp, Provider } from "./calendars/oauth";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`${k} is required`);
  return v;
};
const opt = (k: string) => process.env[k] || undefined;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const port = Number(env("PORT", "8080"));
const publicUrl = env("PUBLIC_URL").replace(/\/$/, "");
const dataDir = env("DATA_DIR", "./data");
const store = new Store(join(dataDir, "meet.sqlite"));
const sealer = new Sealer(loadKey(join(dataDir, "secret.key")));
const now = () => Date.now();

let mailer: Mailer;
if (opt("SMTP_HOST")) {
  mailer = new SmtpMailer({
    host: env("SMTP_HOST"), port: Number(env("SMTP_PORT", "587")), user: env("SMTP_USER"), pass: env("SMTP_PASS"),
    from: env("MAIL_FROM", "meet <noreply@mail.tr1ckyf0x.dev>"),
  });
} else {
  log("SMTP_HOST is not set: emails are printed to the log (development only)");
  mailer = new MemoryMailer(true);
}

const apps: Partial<Record<Provider, OAuthApp>> = {};
for (const p of ["google", "microsoft"] as const) {
  const id = opt(`${p.toUpperCase()}_CLIENT_ID`), secret = opt(`${p.toUpperCase()}_CLIENT_SECRET`);
  if (id && secret) apps[p] = { clientId: id, clientSecret: secret, redirectUri: `${publicUrl}/oauth/${p}/callback` };
}
log(`calendar providers: CalDAV, ICS${apps.google ? ", Google" : ""}${apps.microsoft ? ", Microsoft" : ""}`);

const guard = { allowPrivate: opt("ALLOW_PRIVATE_URLS") === "true" };
const syncer = new Syncer({ store, sealer, guard, apps, now, log });

/** Static files plus the browser bundles, built once at start. */
async function loadAssets(): Promise<Map<string, [string, Uint8Array | string]>> {
  const root = new URL("..", import.meta.url).pathname;
  const assets = new Map<string, [string, Uint8Array | string]>();
  const types: Record<string, string> = { css: "text/css; charset=utf-8", svg: "image/svg+xml", js: "text/javascript; charset=utf-8", png: "image/png" };
  const staticDir = join(root, "web/static");
  for (const f of readdirSync(staticDir)) assets.set(f, [types[f.split(".").pop()!] ?? "application/octet-stream", readFileSync(join(staticDir, f))]);
  const built = await Bun.build({
    entrypoints: [join(root, "client/common.ts"), join(root, "client/group.ts")],
    target: "browser", minify: true, sourcemap: "none", format: "esm",
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  for (const out of built.outputs) assets.set(out.path.split("/").pop()!, [types.js!, await out.text()]);
  return assets;
}

const app = createApp({
  store, sealer, mailer, syncer, publicUrl, now, log, apps, guard,
  signupCode: opt("SIGNUP_CODE") ?? "",
  secureCookies: env("SECURE_COOKIES", "true") === "true",
  revision: process.env.REVISION ?? "dev",
  assets: await loadAssets(),
});

const sweep = () => {
  try {
    const r = store.sweep(now());
    if (r.groups) log(`deleted ${r.groups} expired group(s)`);
  } catch (e) { log(`sweep failed: ${e}`); }
};
sweep();
setInterval(sweep, 15 * 60_000);
// Calendar refresh: connections of people in live groups, every 30 min (checked every 5).
setTimeout(() => void syncer.tick(), 20_000);
setInterval(() => void syncer.tick(), 5 * 60_000);

const server = Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 60 });
log(`meet listening on :${server.port}, public ${publicUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.stop();
    store.close();
    process.exit(0);
  });
}
