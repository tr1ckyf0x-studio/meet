// Building iCalendar files: the meeting attached to emails, and each member's group feed.

export interface IcsEvent {
  uid: string;
  seq: number;
  start: number;
  end: number;
  title: string;
  location?: string;
  description?: string;
  url?: string;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  organizer?: { name: string; email: string };
}

const enc = new TextEncoder();

/** Escapes TEXT values (RFC 5545 3.3.11). */
export function escapeText(s: string): string {
  return s
    .replace(/\r\n|\r|\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") // other control characters have no place in a value
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Folds a content line at 75 octets without splitting a UTF-8 character. */
export function fold(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "", size = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) {
      parts.push(cur);
      cur = "";
      size = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    size += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function eventLines(e: IcsEvent, now: number): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(e.start)}`,
    `DTEND:${icsDate(e.end)}`,
    `SEQUENCE:${e.seq}`,
    `SUMMARY:${escapeText(e.title)}`,
  ];
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  if (e.organizer) lines.push(`ORGANIZER;CN=${e.organizer.name.replace(/[";:,\r\n]/g, "")}:mailto:${e.organizer.email}`);
  lines.push(`STATUS:${e.status}`, `TRANSP:${e.status === "TENTATIVE" ? "TRANSPARENT" : "OPAQUE"}`, "END:VEVENT");
  return lines;
}

function wrap(head: string[], body: string[]): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//tr1ckyf0x//meet//EN", "CALSCALE:GREGORIAN", ...head, ...body, "END:VCALENDAR",
  ].map(fold).join("\r\n") + "\r\n";
}

/** One meeting, for an email attachment. PUBLISH lets any calendar app add it; CANCEL removes it. */
export function buildEventIcs(e: IcsEvent, method: "PUBLISH" | "CANCEL", now: number): string {
  return wrap([`METHOD:${method}`], eventLines(e, now));
}

/** A subscribable calendar holding a group's meeting (or its open proposals while none is set). */
export function buildFeed(name: string, events: IcsEvent[], now: number): string {
  return wrap(
    [`X-WR-CALNAME:${escapeText(name)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", "METHOD:PUBLISH"],
    events.flatMap((e) => eventLines(e, now)),
  );
}

export function googleCalendarLink(e: { title: string; start: number; end: number; location?: string; details?: string }): string {
  const q = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${icsDate(e.start)}/${icsDate(e.end)}` });
  if (e.location) q.set("location", e.location);
  if (e.details) q.set("details", e.details);
  return `https://calendar.google.com/calendar/render?${q}`;
}
