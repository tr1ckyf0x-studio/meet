/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { fmtAgo, fmtTz, fmtYmd, fmtYmdRange } from "../shared/format";
import { ICONS, type IconName } from "../shared/icons";
import { errText, t, type Key, type Lang } from "../shared/i18n";
import type { Connection, Group, User } from "./db";

// Server-rendered pages. Strict CSP: no inline scripts or style attributes; behaviour lives in
// /static/common.js (all pages) and /static/group.js (the group page).

export const SOURCE_URL = "https://github.com/tr1ckyf0x-studio/meet";

export const Icon = ({ n }: { n: IconName }) => <span class="icon" dangerouslySetInnerHTML={{ __html: ICONS[n] }}></span>;

interface Base { lang: Lang; user: User | null; asset: (name: string) => string }

export function Layout(p: Base & { title?: string; children: Child; wide?: boolean; scripts?: string[] }) {
  const L = p.lang;
  return (
    <html lang={L}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <title>{p.title ? `${p.title} · meet` : `meet — ${t(L, "app_tagline")}`}</title>
        <link rel="icon" href={p.asset("favicon.svg")} type="image/svg+xml" />
        <link rel="stylesheet" href={p.asset("style.css")} />
        <script src={p.asset("common.js")} defer></script>
        {(p.scripts ?? []).map((s) => <script src={p.asset(s)} defer></script>)}
      </head>
      <body>
        <header class="top">
          <a class="brand" href="/"><span class="brand-dot"></span>meet</a>
          {p.user ? (
            <nav>
              <a href="/">{t(L, "nav_groups")}</a>
              <a href="/calendars">{t(L, "nav_calendars")}</a>
              <a href="/settings">{t(L, "nav_settings")}</a>
              <form method="post" action="/logout" class="inline"><button class="link">{t(L, "nav_logout")}</button></form>
            </nav>
          ) : (
            <nav><a href="/login">{t(L, "nav_login")}</a></nav>
          )}
        </header>
        <main class={p.wide ? "wide" : ""}>{p.children}</main>
        <footer>
          <span>{t(L, "footer_privacy")}</span>
          <span class="langs">
            <a href={`/lang/ru`} class={L === "ru" ? "on" : ""}>RU</a>
            <a href={`/lang/en`} class={L === "en" ? "on" : ""}>EN</a>
          </span>
          <a href={SOURCE_URL}>{t(L, "footer_source")}</a>
        </footer>
      </body>
    </html>
  );
}

const Err = ({ lang, k }: { lang: Lang; k?: string | null }) => (k ? <p class="error">{t(lang, k as Key)}</p> : null);

export function Landing(p: Base) {
  const L = p.lang;
  return (
    <Layout {...p}>
      <section class="hero">
        <h1>{t(L, "landing_title")}</h1>
        <p class="lead">{t(L, "landing_lead")}</p>
        <ol class="steps">
          <li>{t(L, "landing_s1")}</li>
          <li>{t(L, "landing_s2")}</li>
          <li>{t(L, "landing_s3")}</li>
        </ol>
        <p class="note"><Icon n="lock" /> {t(L, "landing_privacy")}</p>
      </section>
      <section class="card narrow">
        <h2>{t(L, "login_title")}</h2>
        <LoginForm lang={L} />
        <p class="muted small">{t(L, "landing_invite_only")}</p>
      </section>
    </Layout>
  );
}

export function LoginForm(p: { lang: Lang; email?: string; invite?: string; code?: string; next?: string; error?: string | null }) {
  const L = p.lang;
  return (
    <form method="post" action="/login" class="stack">
      <label>
        {t(L, "login_email")}
        <input type="email" name="email" required autocomplete="email" inputmode="email" value={p.email ?? ""} maxlength={254} />
      </label>
      {p.invite ? <input type="hidden" name="invite" value={p.invite} /> : null}
      {p.code ? <input type="hidden" name="code" value={p.code} /> : null}
      {p.next ? <input type="hidden" name="next" value={p.next} /> : null}
      <Err lang={L} k={p.error} />
      <button class="primary">{t(L, "login_send")}</button>
      <p class="muted small">{t(L, "login_hint")}</p>
    </form>
  );
}

export function LoginPage(p: Base & { email?: string; next?: string; error?: string | null }) {
  return (
    <Layout {...p} title={t(p.lang, "login_title")}>
      <section class="card narrow">
        <h1>{t(p.lang, "login_title")}</h1>
        <LoginForm lang={p.lang} email={p.email} next={p.next} error={p.error} />
        <p class="muted small">{t(p.lang, "landing_invite_only")}</p>
      </section>
    </Layout>
  );
}

export function RegisterPage(p: Base & { code: string; error?: string | null }) {
  return (
    <Layout {...p} title={t(p.lang, "register_title")}>
      <section class="card narrow">
        <h1>{t(p.lang, "register_title")}</h1>
        <p>{t(p.lang, "register_lead")}</p>
        <LoginForm lang={p.lang} code={p.code} error={p.error} />
      </section>
    </Layout>
  );
}

export function Message(p: Base & { title: string; text: string; link?: { href: string; label: string } }) {
  return (
    <Layout {...p} title={p.title}>
      <section class="card narrow">
        <h1>{p.title}</h1>
        <p>{p.text}</p>
        {p.link ? <p><a class="button" href={p.link.href}>{p.link.label}</a></p> : null}
      </section>
    </Layout>
  );
}

export function SentPage(p: Base & { email: string }) {
  return (
    <Layout {...p} title={t(p.lang, "login_sent_title")}>
      <section class="card narrow center">
        <div class="big-icon"><Icon n="mail" /></div>
        <h1>{t(p.lang, "login_sent_title")}</h1>
        <p>{t(p.lang, "login_sent_text", { email: p.email })}</p>
        <p class="muted small">{t(p.lang, "login_sent_spam")}</p>
      </section>
    </Layout>
  );
}

export function AuthPage(p: Base & { token: string; email: string }) {
  return (
    <Layout {...p} title={t(p.lang, "auth_title")}>
      <section class="card narrow center">
        <h1>{t(p.lang, "auth_title")}</h1>
        <p>{t(p.lang, "auth_text", { email: p.email })}</p>
        <form method="post" action="/auth">
          <input type="hidden" name="t" value={p.token} />
          <button class="primary big">{t(p.lang, "auth_button")}</button>
        </form>
      </section>
    </Layout>
  );
}

export function TzSelect(p: { name: string; value: string; zones: string[]; now: number; detect?: boolean }) {
  return (
    <select name={p.name} data-detect-tz={p.detect ? "1" : undefined}>
      {p.zones.map((z) => <option value={z} selected={z === p.value}>{fmtTz(z, p.now)}</option>)}
    </select>
  );
}

export function WelcomePage(p: Base & { user: User; next: string; zones: string[]; now: number }) {
  const L = p.lang;
  return (
    <Layout {...p} title={t(L, "welcome_title")}>
      <section class="card narrow">
        <h1>{t(L, "welcome_title")}</h1>
        <form method="post" action="/welcome" class="stack">
          <input type="hidden" name="next" value={p.next} />
          <label>{t(L, "welcome_name")}<input name="name" required maxlength={60} value={p.user.name} autocomplete="name" /></label>
          <label>{t(L, "tz_label")}<TzSelect name="tz" value={p.user.tz} zones={p.zones} now={p.now} detect /></label>
          <label>{t(L, "lang_label")}
            <select name="lang"><option value="ru" selected={L === "ru"}>Русский</option><option value="en" selected={L === "en"}>English</option></select>
          </label>
          <button class="primary">{t(L, "continue")}</button>
        </form>
      </section>
    </Layout>
  );
}

export function HomePage(p: Base & { user: User; groups: (Group & { memberCount: number })[] }) {
  const L = p.lang;
  return (
    <Layout {...p} title={t(L, "home_title")}>
      <div class="row-between">
        <h1>{t(L, "home_title")}</h1>
        <a class="button primary" href="/groups/new"><Icon n="plus" /> {t(L, "home_new")}</a>
      </div>
      {p.groups.length === 0 ? <section class="card empty"><p>{t(L, "home_empty")}</p></section> : (
        <ul class="group-list">
          {p.groups.map((g) => (
            <li>
              <a class="card group-item" href={`/groups/${g.id}`}>
                <span class="title">{g.title}</span>
                <span class="meta">
                  {fmtYmdRange(g.rangeStart, g.rangeEnd, L)} · {t(L, "home_members", { n: g.memberCount })}
                </span>
                <span class={`chip ${g.confirmedId ? "ok" : ""}`}>{t(L, g.confirmedId ? "home_confirmed" : "home_searching")}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

export interface GroupFormValues {
  title: string; days: number; hours: number; minutes: number; rangeStart: string; rangeEnd: string; address: string; expiresOn: string; tz: string;
}

export function GroupFormPage(p: Base & { mode: "new" | "edit"; groupId?: string; v: GroupFormValues; error?: string | null; zones: string[]; now: number }) {
  const L = p.lang;
  const action = p.mode === "new" ? "/groups" : `/groups/${p.groupId}/edit`;
  return (
    <Layout {...p} title={t(L, p.mode === "new" ? "new_title" : "edit_title")}>
      <section class="card form-card">
        <h1>{t(L, p.mode === "new" ? "new_title" : "edit_title")}</h1>
        <form method="post" action={action} class="stack">
          <label>{t(L, "f_title")}<input name="title" required maxlength={120} value={p.v.title} placeholder={t(L, "f_title_ph")} /></label>
          <fieldset>
            <legend>{t(L, "f_duration")}</legend>
            <div class="duration">
              <label><input type="number" name="days" min={0} max={14} value={p.v.days} /> {t(L, "f_days")}</label>
              <label><input type="number" name="hours" min={0} max={23} value={p.v.hours} /> {t(L, "f_hours")}</label>
              <label><input type="number" name="minutes" min={0} max={59} step={15} value={p.v.minutes} /> {t(L, "f_minutes")}</label>
            </div>
          </fieldset>
          <div class="two">
            <label>{t(L, "f_from")}<input type="date" name="rangeStart" required value={p.v.rangeStart} /></label>
            <label>{t(L, "f_to")}<input type="date" name="rangeEnd" required value={p.v.rangeEnd} /></label>
          </div>
          {p.mode === "new" ? (
            <label>{t(L, "tz_label")}<TzSelect name="tz" value={p.v.tz} zones={p.zones} now={p.now} /></label>
          ) : <p class="muted small">{t(L, "f_tz_hint", { tz: p.v.tz })}</p>}
          <label>{t(L, "f_address")} <span class="muted">({t(L, "f_optional")})</span><input name="address" maxlength={300} value={p.v.address} /></label>
          <label>{t(L, "f_expires")}<input type="date" name="expiresOn" required value={p.v.expiresOn} />
            <span class="muted small">{t(L, "f_expires_hint")}</span></label>
          <Err lang={L} k={p.error} />
          <div class="row">
            <button class="primary">{t(L, p.mode === "new" ? "create" : "save")}</button>
            <a class="button" href={p.mode === "new" ? "/" : `/groups/${p.groupId}`}>{t(L, "cancel")}</a>
          </div>
        </form>
        {p.mode === "edit" ? (
          <form method="post" action={`/groups/${p.groupId}/delete`} data-confirm={t(L, "g_delete_confirm")} class="danger-zone">
            <button class="danger">{t(L, "g_delete")}</button>
          </form>
        ) : null}
      </section>
    </Layout>
  );
}

export function InvitePage(p: Base & { group: Group; organizer: string; members: number; isMember: boolean; full: boolean; email?: string; error?: string | null }) {
  const L = p.lang;
  const g = p.group;
  return (
    <Layout {...p} title={g.title}>
      <section class="card narrow">
        <p class="eyebrow">{t(L, "invite_title")}</p>
        <h1>{g.title}</h1>
        <p class="muted">{t(L, "invite_by", { name: p.organizer })}</p>
        <p>{t(L, "invite_when", { range: fmtYmdRange(g.rangeStart, g.rangeEnd, L) })}</p>
        <p class="muted">{t(L, "invite_members", { n: p.members })}</p>
        {p.full ? <p class="error">{t(L, "invite_full")}</p> : p.user ? (
          <form method="post" action={`/g/${g.invite}/join`}><button class="primary big">{t(L, "invite_join")}</button></form>
        ) : (
          <>
            <p>{t(L, "invite_login")}</p>
            <LoginForm lang={L} invite={g.invite} email={p.email} error={p.error} />
          </>
        )}
      </section>
    </Layout>
  );
}

export function GroupPage(p: Base & { title: string; boot: unknown }) {
  const json = JSON.stringify(p.boot).replace(/</g, "\\u003c");
  return (
    <Layout {...p} title={p.title} wide scripts={["group.js"]}>
      <div id="app" class="group-app"><p class="muted">…</p></div>
      <script type="application/json" id="boot" dangerouslySetInnerHTML={{ __html: json }}></script>
    </Layout>
  );
}

function connStatus(L: Lang, c: Connection, now: number): string {
  if (c.status === "error") return t(L, "cal_status_error", { reason: errText(L, c.error) });
  if (c.status === "new" || !c.syncedAt) return t(L, "cal_status_new");
  return t(L, "cal_status_ok", { ago: fmtAgo(c.syncedAt, now, L) });
}

const Kind = ({ k }: { k: string }) => (
  <span class={`kind kind-${k}`}>{k === "google" ? "G" : k === "microsoft" ? "O" : <Icon n={k === "ics" ? "link" : "cloud"} />}</span>
);

export function CalendarsPage(p: Base & { conns: Connection[]; providers: { google: boolean; microsoft: boolean }; back?: string; flash?: string | null; error?: string | null; now: number }) {
  const L = p.lang;
  const back = p.back ? `?back=${encodeURIComponent(p.back)}` : "";
  return (
    <Layout {...p} title={t(L, "calendars_title")}>
      <h1>{t(L, "calendars_title")}</h1>
      <p class="lead">{t(L, "calendars_lead")}</p>
      {p.back ? <p><a href={p.back}>← {t(L, "cal_back_to_group")}</a></p> : null}
      {p.flash ? <p class="flash">{t(L, p.flash as Key)}</p> : null}
      {p.error ? <p class="error">{errText(L, p.error)}</p> : null}
      <section class="card">
        {p.conns.length === 0 ? <p class="muted">{t(L, "cal_none")}</p> : (
          <ul class="conn-list">
            {p.conns.map((c) => (
              <li class={`conn ${c.status}`}>
                <Kind k={c.kind} />
                <a href={`/calendars/${c.id}${back}`} class="label">{c.label}</a>
                <span class="status">{connStatus(L, c, p.now)}</span>
                <form method="post" action={`/calendars/${c.id}/sync${back}`} class="inline"><button class="small">{t(L, "cal_sync")}</button></form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2>{t(L, "cal_add")}</h2>
      <div class="providers">
        <div class="card provider">
          <h3><Kind k="google" /> {t(L, "cal_google")}</h3>
          {p.providers.google ? <a class="button primary" href={`/oauth/google/start${back}`}>{t(L, "cal_connect")}</a> : <span class="chip">{t(L, "cal_soon")}</span>}
        </div>
        <div class="card provider">
          <h3><Kind k="microsoft" /> {t(L, "cal_microsoft")}</h3>
          {p.providers.microsoft ? <a class="button primary" href={`/oauth/microsoft/start${back}`}>{t(L, "cal_connect")}</a> : <span class="chip">{t(L, "cal_soon")}</span>}
        </div>
        {(["icloud", "yandex", "fastmail", "other"] as const).map((prov) => (
          <details class="card provider">
            <summary><h3><Kind k="caldav" /> {t(L, `cal_${prov}` as Key)}</h3></summary>
            <form method="post" action={`/calendars/caldav${back}`} class="stack">
              <input type="hidden" name="provider" value={prov} />
              <p class="muted small">{t(L, `cal_help_${prov}` as Key)}</p>
              {prov === "other" ? <label>{t(L, "cal_url")}<input name="url" type="url" required placeholder="https://" /></label> : null}
              <label>{t(L, "cal_username")}<input name="username" required autocomplete="off" /></label>
              <label>{t(L, "cal_password")}<input name="password" type="password" required autocomplete="new-password" /></label>
              <button class="primary">{t(L, "cal_connect")}</button>
            </form>
          </details>
        ))}
        <details class="card provider">
          <summary><h3><Kind k="ics" /> {t(L, "cal_ics")}</h3></summary>
          <form method="post" action={`/calendars/ics${back}`} class="stack">
            <p class="muted small">{t(L, "cal_help_ics")}</p>
            <label>{t(L, "cal_ics_url")}<input name="url" required placeholder="https://… / webcal://…" autocomplete="off" /></label>
            <label>{t(L, "cal_label")}<input name="label" maxlength={60} /></label>
            <button class="primary">{t(L, "cal_connect")}</button>
          </form>
        </details>
      </div>
    </Layout>
  );
}

export function ConnectionPage(p: Base & { conn: Connection; calendars: { id: string; name: string; selected: boolean }[] | null; back?: string; flash?: string | null; now: number }) {
  const L = p.lang;
  const back = p.back ? `?back=${encodeURIComponent(p.back)}` : "";
  return (
    <Layout {...p} title={p.conn.label}>
      <p><a href={`/calendars${back}`}>← {t(L, "calendars_title")}</a></p>
      {p.flash ? <p class="flash">{t(L, p.flash as Key)}</p> : null}
      <section class="card form-card">
        <h1>{p.conn.label}</h1>
        <p class="muted">{connStatus(L, p.conn, p.now)}</p>
        <form method="post" action={`/calendars/${p.conn.id}${back}`} class="stack">
          <label>{t(L, "cal_label")}<input name="label" maxlength={60} value={p.conn.label} /></label>
          {p.calendars ? (
            <fieldset>
              <legend>{t(L, "cal_choose")}</legend>
              {p.calendars.map((c) => (
                <label class="check"><input type="checkbox" name="cal" value={c.id} checked={c.selected} /> {c.name}</label>
              ))}
            </fieldset>
          ) : null}
          <div class="row">
            <button class="primary">{t(L, "save")}</button>
            {p.back ? <a class="button" href={p.back}>{t(L, "cal_back_to_group")}</a> : null}
          </div>
        </form>
        <form method="post" action={`/calendars/${p.conn.id}/delete${back}`} class="danger-zone">
          <button class="danger">{t(L, "cal_delete")}</button>
        </form>
      </section>
    </Layout>
  );
}

export function SettingsPage(p: Base & { user: User; zones: string[]; now: number; saved?: boolean }) {
  const L = p.lang;
  return (
    <Layout {...p} title={t(L, "settings_title")}>
      <section class="card form-card">
        <h1>{t(L, "settings_title")}</h1>
        <p class="muted">{t(L, "settings_email", { email: p.user.email })}</p>
        {p.saved ? <p class="flash">{t(L, "saved")}</p> : null}
        <form method="post" action="/settings" class="stack">
          <label>{t(L, "welcome_name")}<input name="name" required maxlength={60} value={p.user.name} /></label>
          <label>{t(L, "tz_label")}<TzSelect name="tz" value={p.user.tz} zones={p.zones} now={p.now} /></label>
          <label>{t(L, "lang_label")}
            <select name="lang"><option value="ru" selected={L === "ru"}>Русский</option><option value="en" selected={L === "en"}>English</option></select>
          </label>
          <button class="primary">{t(L, "save")}</button>
        </form>
        <form method="post" action="/settings/delete" class="danger-zone" data-confirm={t(L, "settings_delete_text")}>
          <h2>{t(L, "settings_delete")}</h2>
          <p class="muted small">{t(L, "settings_delete_text")}</p>
          <button class="danger">{t(L, "settings_delete_confirm")}</button>
        </form>
      </section>
    </Layout>
  );
}
