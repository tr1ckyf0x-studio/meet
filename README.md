# meet

Find a time for a group meeting. Someone creates a meeting and shares a link; everyone marks when they can by
hand or connects their calendars; the service shows when everyone is free, across time zones, suggests slots,
and runs a vote. When everyone agrees, each member gets an email with an `.ics` invitation, and every member
can subscribe to the meeting as a separate calendar (`webcal://…`).

Live at https://meet.tr1ckyf0x.dev (sign-up through a meeting invitation).

*По-русски:* сервис, чтобы группа людей нашла общее время для встречи. Участники отмечают время вручную или
подключают свои календари (Google, iCloud, Яндекс, Outlook, любой CalDAV или ICS-ссылку); сервис видит только
«занят с… по…», предлагает слоты, участники голосуют, а когда согласны все, каждому приходит приглашение `.ics`.

## Privacy

- From calendars only busy intervals are kept: `[start, end)`. Titles, descriptions, attendees and locations are
  parsed in memory and dropped. Google is read through its FreeBusy API, which returns nothing else at all.
- Other members see *who* is busy at a given time inside the meeting's date range, never *what* it is.
- Calendar passwords, OAuth refresh tokens and secret ICS links are encrypted (AES-256-GCM) with a key generated on
  first start into the data directory, so a copy of the database alone does not reveal them.
- A meeting, with all marks and votes in it, is deleted after the date its organizer chose.
- URLs users give (ICS links, CalDAV servers) are fetched only if they resolve to public addresses.

## Features

- Email + magic link sign-in, no passwords. New accounts only through a meeting invitation (or a bootstrap code).
- Calendars: CalDAV with an app password (iCloud, Yandex, Fastmail, Nextcloud, Radicale, …), any ICS link,
  Google Calendar and Outlook / Microsoft 365 (OAuth). Recurring events, time zones (IANA and Windows names), all-day
  and transparent events are handled.
- Shared grid by days in any member's time zone, hand marks ("can" / "can't") on top of calendars.
- Suggestions: windows where everyone is free, or, failing that, all but one or two (named).
- Proposals, votes; the organizer can mark agreement for someone they asked elsewhere; the meeting is set when
  everyone agrees. Cancellation sends a CANCEL.
- Russian and English UI.

## Running

Bun 1.4, SQLite, one process. `docker build .` runs the tests and the type check.

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | e.g. `https://meet.example.com` (required) |
| `DATA_DIR` | database and key file (`/data` in the image) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | outgoing mail; without `SMTP_HOST` mails are printed to the log |
| `SIGNUP_CODE` | lets `/register?code=…` create accounts without an invitation (for the first organizer) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | enables Google Calendar |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | enables Outlook / Microsoft 365 |
| `SECURE_COOKIES` | `false` for plain-HTTP local runs |
| `ALLOW_PRIVATE_URLS` | `true` only for local testing against a CalDAV server on your network |

### Google Calendar

1. https://console.cloud.google.com → create a project → *APIs & Services → Library* → enable **Google Calendar API**.
2. *Google Auth Platform → Branding*: app name, support email, authorized domain (your domain); *Audience*: External,
   then **Publish app** (in "Testing" refresh tokens expire after 7 days).
3. *Data Access → Add or remove scopes*: `openid`, `email`, `…/auth/calendar.freebusy`,
   `…/auth/calendar.calendarlist.readonly`.
4. *Clients → Create client* → Web application, authorized redirect URI `https://<host>/oauth/google/callback`.
5. Put the client id and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Without Google's verification users see an "unverified app" warning they can pass, and the app is limited to 100 users.

### Outlook / Microsoft 365

1. https://entra.microsoft.com → *App registrations → New registration*; supported accounts: **any organizational
   directory and personal Microsoft accounts**; redirect URI (Web) `https://<host>/oauth/microsoft/callback`.
2. *API permissions → Microsoft Graph → Delegated*: `offline_access`, `openid`, `email`, `User.Read`, `Calendars.ReadBasic`.
3. *Certificates & secrets → New client secret* (note its expiry date).
4. Put the *Application (client) ID* and the secret value into `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`.

## Development

```sh
bun install
bun test
bun run check
PUBLIC_URL=http://127.0.0.1:8080 SECURE_COOKIES=false SIGNUP_CODE=dev DATA_DIR=./data bun run dev
```

Layout: `server/` (Hono app, store, calendar adapters, mail), `shared/` (time-zone and interval math, strings — also
bundled into the browser), `client/` (the group page), `web/static/`, `test/`, `docs/superpowers/` (design and plan).
