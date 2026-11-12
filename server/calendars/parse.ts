import ICAL from "ical.js";
import { normalize, type Iv } from "../../shared/intervals";
import { DAY, isValidTz, zonedToUtc } from "../../shared/time";

// iCalendar text -> busy intervals. Only start and end survive; titles, descriptions, attendees and
// locations are read by the parser in memory and dropped with it.

const MAX_OCCURRENCES = 20_000; // per series
const MAX_STEPS = 300_000; // per sync, all series together: a crafted feed must not freeze the server
const MAX_EVENTS = 50_000;

/** Thrown when a feed needs more work than any real calendar does. */
export class CalendarTooComplex extends Error {}

/** Work allowed for one sync; shared by all documents of a CalDAV calendar. */
export interface Budget { steps: number; events: number }
export const newBudget = (): Budget => ({ steps: 0, events: 0 });

/** Windows zone names Outlook/Exchange put into TZID, mapped to IANA. */
const WINDOWS_TZ: Record<string, string> = {
  "UTC": "UTC", "Coordinated Universal Time": "UTC", "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin", "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw", "Romance Standard Time": "Europe/Paris",
  "E. Europe Standard Time": "Europe/Chisinau", "FLE Standard Time": "Europe/Kiev", "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow", "Belarus Standard Time": "Europe/Minsk", "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem", "Arabian Standard Time": "Asia/Dubai", "Georgian Standard Time": "Asia/Tbilisi",
  "Caucasus Standard Time": "Asia/Yerevan", "Azerbaijan Standard Time": "Asia/Baku", "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "West Asia Standard Time": "Asia/Tashkent", "Central Asia Standard Time": "Asia/Almaty", "India Standard Time": "Asia/Kolkata",
  "Nepal Standard Time": "Asia/Kathmandu", "N. Central Asia Standard Time": "Asia/Novosibirsk", "SE Asia Standard Time": "Asia/Bangkok",
  "China Standard Time": "Asia/Shanghai", "Singapore Standard Time": "Asia/Singapore", "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul", "AUS Eastern Standard Time": "Australia/Sydney", "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles", "US Mountain Standard Time": "America/Phoenix", "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu", "Atlantic Standard Time": "America/Halifax", "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires", "SA Pacific Standard Time": "America/Bogota", "Mexico Standard Time": "America/Mexico_City",
  "Central America Standard Time": "America/Guatemala", "Canada Central Standard Time": "America/Regina",
  "South Africa Standard Time": "Africa/Johannesburg", "Egypt Standard Time": "Africa/Cairo", "Morocco Standard Time": "Africa/Casablanca",
};

/** A TZID as an IANA zone, if it is one (also "/mozilla.org/.../Europe/Berlin" style prefixes and Windows names). */
export function resolveTzid(tzid: string | null | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.replace(/^"|"$/g, "").trim();
  if (WINDOWS_TZ[t]) return WINDOWS_TZ[t]!;
  if (isValidTz(t) && t.includes("/")) return t;
  if (t === "UTC" || t === "GMT" || t === "Etc/UTC") return "UTC";
  const tail = /([A-Za-z_]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?)$/.exec(t)?.[1];
  return tail && isValidTz(tail) ? tail : null;
}

type ITime = ICAL.Time;

function toMs(t: ITime, tzid: string | null, userTz: string): number {
  if (t.isDate) return zonedToUtc(t.year, t.month, t.day, 0, 0, userTz);
  const zone = t.zone as ICAL.Timezone | undefined;
  if (zone && (zone === ICAL.Timezone.utcTimezone || zone.tzid === "UTC" || zone.tzid === "Z")) {
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  }
  const iana = resolveTzid(tzid);
  if (iana) return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, iana) + t.second * 1000;
  if (zone && zone.tzid && zone.tzid !== "floating" && zone !== ICAL.Timezone.localTimezone) return t.toUnixTime() * 1000;
  return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, userTz) + t.second * 1000;
}

function tzidOf(ev: ICAL.Event, prop: "dtstart" | "dtend"): string | null {
  const p = ev.component.getFirstProperty(prop);
  const v = p?.getParameter("tzid");
  return typeof v === "string" ? v : null;
}

function isBusy(ev: ICAL.Event): boolean {
  const c = ev.component;
  const status = String(c.getFirstPropertyValue("status") ?? "").toUpperCase();
  if (status === "CANCELLED") return false;
  if (String(c.getFirstPropertyValue("transp") ?? "").toUpperCase() === "TRANSPARENT") return false;
  if (String(c.getFirstPropertyValue("x-microsoft-cdo-busystatus") ?? "").toUpperCase() === "FREE") return false;
  return true;
}

function span(ev: ICAL.Event, start: ITime, end: ITime | null, userTz: string): Iv | null {
  const s = toMs(start, tzidOf(ev, "dtstart"), userTz);
  let e: number;
  if (end) e = toMs(end, tzidOf(ev, "dtend") ?? tzidOf(ev, "dtstart"), userTz);
  else e = start.isDate ? s + DAY : s;
  return e > s ? [s, e] : null;
}

/** Busy intervals inside [lo, hi) from one iCalendar document (one or more VCALENDARs). */
export function busyFromIcs(text: string, lo: number, hi: number, userTz: string, budget: Budget = newBudget()): Iv[] {
  const parsed = ICAL.parse(text) as unknown;
  const roots = (Array.isArray(parsed) && typeof parsed[0] !== "string" ? parsed : [parsed]) as unknown[];
  const out: Iv[] = [];
  const registered: string[] = [];
  try {
    for (const root of roots) {
      const cal = new ICAL.Component(root as never);
      // VTIMEZONE definitions are only needed for zones Intl does not know.
      for (const vtz of cal.getAllSubcomponents("vtimezone")) {
        const id = vtz.getFirstPropertyValue("tzid");
        if (typeof id === "string" && !resolveTzid(id) && !ICAL.TimezoneService.has(id)) {
          ICAL.TimezoneService.register(vtz);
          registered.push(id);
        }
      }
      const byUid = new Map<string, { master?: ICAL.Component; exceptions: ICAL.Component[] }>();
      for (const ve of cal.getAllSubcomponents("vevent")) {
        if (++budget.events > MAX_EVENTS) throw new CalendarTooComplex("too many events");
        const uid = String(ve.getFirstPropertyValue("uid") ?? Math.random());
        const entry = byUid.get(uid) ?? { exceptions: [] };
        if (ve.hasProperty("recurrence-id")) entry.exceptions.push(ve); else entry.master = ve;
        byUid.set(uid, entry);
      }
      for (const { master, exceptions } of byUid.values()) {
        if (!master) {
          for (const x of exceptions) {
            const ev = new ICAL.Event(x);
            if (!isBusy(ev)) continue;
            const iv = span(ev, ev.startDate, ev.endDate, userTz);
            if (iv) out.push(iv);
          }
          continue;
        }
        const ev = new ICAL.Event(master);
        for (const x of exceptions) {
          try { ev.relateException(new ICAL.Event(x)); } catch { /* an exception for another series */ }
        }
        if (!ev.isRecurring()) {
          if (!isBusy(ev)) continue;
          const iv = span(ev, ev.startDate, ev.endDate, userTz);
          if (iv) out.push(iv);
          continue;
        }
        // Sub-hourly repetition is not a calendar anyone keeps; it is a way to burn CPU.
        const freq = String((master.getFirstPropertyValue("rrule") as { freq?: string } | null)?.freq ?? "").toUpperCase();
        if (freq === "SECONDLY" || freq === "MINUTELY") continue;
        const it = ev.iterator();
        const startTz = tzidOf(ev, "dtstart");
        // Exceptions can move an instance up to a week later; keep iterating a bit past the window.
        const stopAt = hi + 7 * DAY;
        // Wall time is within ±14 h of UTC, so anything this far before the window can be skipped without Intl.
        const skipBefore = lo - 3 * DAY;
        for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
          if (++budget.steps > MAX_STEPS) throw new CalendarTooComplex("too many occurrences");
          if (Date.UTC(next.year, next.month - 1, next.day, next.hour, next.minute) < skipBefore) continue;
          if (toMs(next, startTz, userTz) >= stopAt) break;
          const d = ev.getOccurrenceDetails(next);
          if (!isBusy(d.item)) continue;
          const iv = d.item === ev ? span(ev, d.startDate, d.endDate, userTz) : span(d.item, d.startDate, d.endDate, userTz);
          if (iv && iv[1] > lo && iv[0] < hi) out.push(iv);
        }
      }
    }
  } finally {
    for (const id of registered) ICAL.TimezoneService.remove(id);
  }
  return normalize(out.map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)] as Iv));
}
