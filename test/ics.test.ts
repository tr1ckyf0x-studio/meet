import { describe, expect, test } from "bun:test";
import { busyFromIcs, resolveTzid } from "../server/calendars/parse";
import { buildEventIcs, buildFeed, escapeText, fold, googleCalendarLink } from "../server/ics";

const Z = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h, mi);
const lo = Z(10, 1, 0), hi = Z(12, 1, 0);

const ICS = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n${body.trim().replace(/\n/g, "\r\n")}\r\nEND:VCALENDAR\r\n`;

describe("busyFromIcs", () => {
  test("UTC, recurring with EXDATE and a moved instance, transparent, cancelled", () => {
    const text = ICS(`
BEGIN:VEVENT
UID:1
DTSTART:20261112T100000Z
DTEND:20261112T110000Z
SUMMARY:Doctor
END:VEVENT
BEGIN:VEVENT
UID:2
DTSTART;TZID=Europe/Belgrade:20261102T180000
DTEND;TZID=Europe/Belgrade:20261102T190000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=Europe/Belgrade:20261109T180000
END:VEVENT
BEGIN:VEVENT
UID:2
RECURRENCE-ID;TZID=Europe/Belgrade:20261116T180000
DTSTART;TZID=Europe/Belgrade:20261116T200000
DTEND;TZID=Europe/Belgrade:20261116T210000
END:VEVENT
BEGIN:VEVENT
UID:3
DTSTART:20261113T100000Z
DTEND:20261113T110000Z
TRANSP:TRANSPARENT
END:VEVENT
BEGIN:VEVENT
UID:4
DTSTART:20261113T120000Z
DTEND:20261113T130000Z
STATUS:CANCELLED
END:VEVENT`);
    expect(busyFromIcs(text, lo, hi, "UTC")).toEqual([
      [Z(11, 2, 17), Z(11, 2, 18)],
      [Z(11, 12, 10), Z(11, 12, 11)],
      [Z(11, 16, 19), Z(11, 16, 20)],
      [Z(11, 23, 17), Z(11, 23, 18)],
    ]);
  });

  test("all-day and floating times use the user's zone; Windows and custom TZIDs", () => {
    const text = ICS(`
BEGIN:VTIMEZONE
TZID:My Zone
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0300
TZOFFSETTO:+0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:a
DTSTART;VALUE=DATE:20261114
DTEND;VALUE=DATE:20261115
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART:20261113T090000
DTEND:20261113T100000
END:VEVENT
BEGIN:VEVENT
UID:c
DTSTART;TZID=W. Europe Standard Time:20261113T150000
DTEND;TZID=W. Europe Standard Time:20261113T160000
END:VEVENT
BEGIN:VEVENT
UID:d
DTSTART;TZID=My Zone:20261113T120000
DTEND;TZID=My Zone:20261113T123000
END:VEVENT`);
    expect(busyFromIcs(text, lo, hi, "Asia/Tokyo")).toEqual([
      [Z(11, 13, 0), Z(11, 13, 1)], // floating 09:00 Tokyo
      [Z(11, 13, 9), Z(11, 13, 9, 30)], // My Zone +03
      // Berlin 15:00-16:00 (14-15Z) touches the all-day 14 Nov in Tokyo (15Z-15Z), so they merge.
      [Z(11, 13, 14), Z(11, 14, 15)],
    ]);
  });

  test("a weekly event keeps its wall time across a DST change", () => {
    const text = ICS(`
BEGIN:VEVENT
UID:w
DTSTART;TZID=Europe/Belgrade:20261019T100000
DTEND;TZID=Europe/Belgrade:20261019T110000
RRULE:FREQ=WEEKLY;UNTIL=20261103T000000Z
END:VEVENT`);
    expect(busyFromIcs(text, lo, hi, "UTC")).toEqual([
      [Z(10, 19, 8), Z(10, 19, 9)],
      [Z(10, 26, 9), Z(10, 26, 10)],
      [Z(11, 2, 9), Z(11, 2, 10)],
    ]);
  });

  test("an endless daily series stops at the window", () => {
    const text = ICS(`
BEGIN:VEVENT
UID:d
DTSTART:20200101T080000Z
DTEND:20200101T083000Z
RRULE:FREQ=DAILY
END:VEVENT`);
    const r = busyFromIcs(text, Z(11, 1, 0), Z(11, 4, 0), "UTC");
    expect(r).toEqual([[Z(11, 1, 8), Z(11, 1, 8, 30)], [Z(11, 2, 8), Z(11, 2, 8, 30)], [Z(11, 3, 8), Z(11, 3, 8, 30)]]);
  });

  test("TZID spellings", () => {
    expect(resolveTzid("/mozilla.org/20050126_1/Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveTzid("Pacific Standard Time")).toBe("America/Los_Angeles");
    expect(resolveTzid("Nowhere")).toBeNull();
  });
});

describe("building iCalendar", () => {
  test("a meeting re-parses to the same interval and keeps text intact", () => {
    const text = buildEventIcs({
      uid: "group-x@meet", seq: 2, start: Z(11, 20, 18), end: Z(11, 21, 9), title: "Ужин, вино; ночёвка",
      location: "Белград, Кнез Михаилова 1", description: "https://meet.tr1ckyf0x.dev/groups/x", status: "CONFIRMED",
    }, "PUBLISH", Z(11, 12, 0));
    expect(text).toContain("METHOD:PUBLISH");
    expect(text).toContain("SUMMARY:Ужин\\, вино\\; ночёвка");
    expect(text.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(busyFromIcs(text, lo, hi, "UTC")).toEqual([[Z(11, 20, 18), Z(11, 21, 9)]]);
  });

  test("the feed marks tentative proposals as free time", () => {
    const text = buildFeed("Встреча", [{ uid: "p1", seq: 0, start: Z(11, 20, 18), end: Z(11, 20, 19), title: "x", status: "TENTATIVE" }], 0);
    expect(text).toContain("X-WR-CALNAME:Встреча");
    expect(text).toContain("TRANSP:TRANSPARENT");
  });

  test("helpers", () => {
    expect(escapeText("a\\b\nc")).toBe("a\\\\b\\nc");
    expect(fold("x".repeat(80)).split("\r\n ")).toHaveLength(2);
    expect(googleCalendarLink({ title: "T", start: Z(11, 20, 18), end: Z(11, 20, 19) })).toContain("dates=20261120T180000Z%2F20261120T190000Z");
  });
});
