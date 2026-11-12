# meet: find a time for a group meeting

Date: 2026-11-12. Public host `meet.tr1ckyf0x.dev`, public repo `tr1ckyf0x-studio/meet`.

## Intent (the owner's words, condensed)

People in different countries and time zones, or in one city, need one meeting. A person creates a group
for that meeting and shares a link. Every participant either marks by hand when they can, or connects their
calendars (any number: Google, iCloud, Yandex, any CalDAV, Outlook). The service never stores what is in
those calendars, only when the person is busy. Everyone sees a calendar by days with the free time, and
the service suggests slots where everyone is free. Any participant can propose a slot; participants vote;
when everyone agrees, the meeting is set and everyone gets an email with an `.ics` file. Each group also
has its own calendar feed to subscribe to (macOS Calendar etc.) as a separate calendar.

Owner's decisions:

- Registration is required, **email + magic link only** (no passwords). New accounts only through a group
  link.
- A group is for **one meeting** and is deleted after an expiry date the **creator** sets.
- Participants **see who is busy** at a given time, never what the busy time is.
- Any participant may propose a slot. Several proposals are **voted** on. A meeting is set when **every
  participant agrees**; the organizer (group creator) may mark agreement on someone's behalf (after asking
  them in a messenger).
- A meeting has an **address**.
- No limits on hours: meetings may be at night, overnight, several days long.
- Calendars: Google and Microsoft through their OAuth apps (the owner registers them), everything CalDAV
  (iCloud, Yandex, Fastmail, Nextcloud, other) with an app password, and any calendar by secret ICS link.
- UI in Russian and English. Stack: TypeScript + Bun (as baraholka/kinklist). Deployed by Komodo.

## Anti-goals

- Storing event titles, descriptions, attendees or locations from anyone's calendar. Parsed in memory,
  only `[start, end)` intervals are kept.
- Showing anyone's busy time outside the group's date range, or to non-members.
- Letting the server be used to probe the home network (user-supplied URLs are fetched server-side).

## Claude's calls (the owner may override)

- **Bootstrap:** the first account(s) register through `/register?code=<SIGNUP_CODE>` (as baraholka);
  afterwards anyone with an account can create groups, and new people join through group links.
- **Group fields:** title, duration (15 min to 14 days), date range (up to 92 days), address (optional),
  expiry date (default range end + 7 days, at most a year away), time zone (the creator's; it defines what
  the range dates mean).
- **Availability model:** per member = base + manual overrides.
  - Base: if the member uses at least one calendar in this group, free except calendar busy time; otherwise
    unavailable everywhere (paint when you can, as when2meet).
  - Manual: painted intervals "can" or "can't" override the base.
  - A member with no calendar and nothing painted is "not marked yet". Suggestions use all members; members
    not marked yet are listed as missing.
- **Suggestions:** windows of common free time at least as long as the meeting; if none, the best windows
  with all but one or two members, naming who is missing.
- **Calendars belong to the user**, are reused across their groups, and in each group the user can untick
  calendars that should not count (default: all count).
- **Emails:** magic links (15 min, single use; the link opens a page with a button, so mail scanners do not
  burn it), and on confirmation an email per member in their language and time zone with `invite.ics`
  (METHOD:PUBLISH) and an "add to Google Calendar" link. Cancelling a set meeting sends a CANCEL.
  Sent through the Brevo relay (`noreply@mail.tr1ckyf0x.dev`), the same as Authentik.
- **Feed:** a per-member secret URL `/feed/<token>.ics` (webcal), containing the set meeting, and while
  nothing is set, the open proposals as tentative events.
- **Sync:** connections of users in live groups refresh every 30 min and when a group page is opened
  (if older than 10 min). Google uses the FreeBusy API (scopes `calendar.freebusy` +
  `calendar.calendarlist.readonly`), Microsoft Graph `calendarView` with `$select=start,end,showAs`
  (`Calendars.ReadBasic`), CalDAV `calendar-query` with a time range, ICS by download. Recurrences and
  time zones through `ical.js`. Transparent and cancelled events are ignored.
- **Secrets at rest:** CalDAV passwords, OAuth refresh tokens and ICS URLs are AES-256-GCM encrypted with a
  key generated on first start into the data volume (`/data/secret.key`), so a copy of the database alone
  does not reveal them.
- **SSRF guard:** user URLs must be http(s), resolve only to public addresses (every redirect re-checked),
  bounded in size and time.
- **Limits:** 50 members per group, rate-limited magic links (per address and per IP).

## Builder's freedom

Page layout, styling, grid interaction details, code structure, test layout.
