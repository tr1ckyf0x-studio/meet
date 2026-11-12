# meet — notes for working on this repo

Public repo. Never commit secrets, real people's data, or anything from `data/`. Design: `docs/superpowers/specs/`,
plan: `docs/superpowers/plans/`. Deploy notes for the owner's server live outside the repo (`~/docker-services/meet/CLAUDE.md`).

## Shape

- Bun + Hono + `bun:sqlite` (WAL, `busy_timeout=5000`), zod. Server pages are Hono JSX (`server/views.tsx`); the group page
  is a small vanilla-TS app (`client/group.ts`) bundled by `Bun.build` at startup (`server/main.ts`, `loadAssets`).
- `shared/` is imported by both sides: `time.ts` (zone math on Intl: `zonedToUtc`, DST gaps/overlaps), `intervals.ts`
  (half-open `[s, e)` lists, `applyStroke` for hand marks), `i18n.ts` (ru/en, `{n|one|few|many}` plurals), `format.ts`.
- Strict CSP (`script-src 'self'`, `style-src 'self'`): no inline scripts, no `style=""` in HTML (CSSOM from JS is fine),
  no inline handlers (`client/common.ts` handles `data-confirm` and `data-copy`).

## Rules that matter

- **Only intervals leave a calendar.** Every adapter (`server/calendars/*`) returns `Iv[]`; nothing else is stored.
  Other members get a member's merged `unavailable` clipped to the group's range (`meeting.ts`, `groupState`), never
  emails or connection labels.
- **User URLs go through `safeFetch`** (`fetchguard.ts`): node:http with a `lookup` that checks every address, so the
  socket goes to the checked IP (Bun honours `lookup`; IP literals skip it and are checked before the request). Public
  addresses only, deny lists from the env (own zone, the home WAN address), every redirect re-checked, Basic auth only to
  the same site (iCloud hops between `pNN-caldav.icloud.com`). Tests pin IPv4-mapped IPv6 tricks too.
- **Parsing has a budget** (`parse.ts`): 300k recurrence steps per sync, sub-hourly series skipped; over it the
  connection fails with `too_large` rather than silently reading half a calendar. Zone offsets are cached per quarter hour.
- **Only calendars with status `ok` count**: a new or failing one must not make its owner look free all day.
- **Mail is budgeted** (the relay's daily quota is shared with other services): login mails 150/day, per invite 30/h,
  meeting mails 200/day, cancels 3 per group per day. `clientIp` trusts `CF-Connecting-IP` only from Cloudflare peers.
- **Magic links**: 15 min, single use, GET shows a button and only POST consumes (mail scanners prefetch links).
  `/login` answers the same whether or not an email gets sent.
- **A meeting is set** when every member (at least two) says yes to an open proposal (`evaluate`); join/leave/votes re-run it.
  The organizer may vote for others. Cancel → `METHOD:CANCEL` with a higher `SEQUENCE` (`groups.seq`).
- **Availability model**: with calendars a member is free except busy; without, unavailable except painted "can".
  Members who marked nothing are `pending` and left out of suggestions (`availability.ts`).
- Two app instances overlap for seconds during a zero-downtime deploy: periodic jobs (sweep, sync tick) must tolerate a
  double run (they do: idempotent deletes, busy rows replaced in a transaction).

## Testing

`bun test` (unit + app tests with `MemoryMailer`, fake CalDAV servers on 127.0.0.1 via `allowHosts`),
`bun run check` (tsc). The Docker build runs both. Browser smoke against a running instance: `../tools/ui-smoke.mjs`
on the owner's server (reads magic links from `docker logs`).
