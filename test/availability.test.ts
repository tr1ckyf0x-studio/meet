import { describe, expect, test } from "bun:test";
import { memberUnavailable, suggest } from "../server/availability";
import { HOUR } from "../shared/time";

const lo = Date.UTC(2026, 10, 12, 0), hi = Date.UTC(2026, 10, 13, 0);
const h = (n: number) => lo + n * HOUR;

describe("memberUnavailable", () => {
  test("with calendars: free except busy, marks override", () => {
    const u = memberUnavailable({ lo, hi, hasCalendars: true, calendarBusy: [[h(9), h(17)]], marks: [[h(12), h(13), 1], [h(20), h(22), 0]] });
    expect(u).toEqual([[h(9), h(12)], [h(13), h(17)], [h(20), h(22)]]);
  });

  test("without calendars: unavailable except painted 'can'", () => {
    const u = memberUnavailable({ lo, hi, hasCalendars: false, calendarBusy: [], marks: [[h(18), h(21), 1]] });
    expect(u).toEqual([[lo, h(18)], [h(21), hi]]);
  });

  test("busy outside the range is cut off", () => {
    const u = memberUnavailable({ lo, hi, hasCalendars: true, calendarBusy: [[lo - 5 * HOUR, h(2)], [hi - HOUR, hi + 9 * HOUR]], marks: [] });
    expect(u).toEqual([[lo, h(2)], [hi - HOUR, hi]]);
  });
});

describe("suggest", () => {
  test("a common window long enough for the meeting", () => {
    const r = suggest([
      { id: "a", responded: true, unavailable: [[lo, h(18)]] },
      { id: "b", responded: true, unavailable: [[h(20), hi]] },
    ], lo, hi, 2 * HOUR);
    expect(r.missing).toBe(0);
    expect(r.windows).toEqual([{ start: h(18), end: h(20), missingIds: [] }]);
  });

  test("members who marked nothing do not block, they are pending", () => {
    const r = suggest([
      { id: "a", responded: true, unavailable: [[lo, h(10)]] },
      { id: "c", responded: false, unavailable: [[lo, hi]] },
    ], lo, hi, HOUR);
    expect(r.pending).toEqual(["c"]);
    expect(r.windows[0]).toEqual({ start: h(10), end: hi, missingIds: [] });
  });

  test("no common time: windows without one member, naming them", () => {
    const r = suggest([
      { id: "a", responded: true, unavailable: [[h(12), hi]] },
      { id: "b", responded: true, unavailable: [[lo, h(12)]] },
      { id: "c", responded: true, unavailable: [] },
    ], lo, hi, 3 * HOUR);
    expect(r.missing).toBe(1);
    expect(r.windows).toEqual([
      { start: lo, end: h(12), missingIds: ["b"] },
      { start: h(12), end: hi, missingIds: ["a"] },
    ]);
  });

  test("windows shorter than the meeting are dropped", () => {
    const r = suggest([{ id: "a", responded: true, unavailable: [[h(1), h(23)]] }], lo, hi, 2 * HOUR);
    expect(r.windows).toEqual([]);
  });
});
