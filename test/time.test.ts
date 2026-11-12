import { describe, expect, test } from "bun:test";
import { addDays, isValidTz, parseYmd, tzOffset, ymdOf, zonedParts, zonedToUtc } from "../shared/time";

describe("time zones", () => {
  test("offsets, including 45-minute ones", () => {
    expect(tzOffset(Date.UTC(2026, 0, 15, 12), "Asia/Kathmandu")).toBe((5 * 60 + 45) * 60_000);
    expect(tzOffset(Date.UTC(2026, 0, 15, 12), "Europe/Belgrade")).toBe(60 * 60_000);
    expect(tzOffset(Date.UTC(2026, 6, 15, 12), "Europe/Belgrade")).toBe(2 * 60 * 60_000);
    expect(tzOffset(Date.UTC(2026, 6, 15, 12), "UTC")).toBe(0);
  });

  test("wall time to UTC", () => {
    expect(zonedToUtc(2026, 11, 12, 18, 0, "Europe/Belgrade")).toBe(Date.UTC(2026, 10, 12, 17, 0));
    expect(zonedToUtc(2026, 11, 12, 0, 0, "Asia/Kathmandu")).toBe(Date.UTC(2026, 10, 11, 18, 15));
    expect(zonedToUtc(2026, 11, 12, 9, 30, "America/Los_Angeles")).toBe(Date.UTC(2026, 10, 12, 17, 30));
  });

  test("DST gap moves forward, DST overlap picks the first occurrence", () => {
    // 2026-03-29 02:30 does not exist in Belgrade (clocks jump 02:00 -> 03:00).
    expect(zonedToUtc(2026, 3, 29, 2, 30, "Europe/Belgrade")).toBe(Date.UTC(2026, 2, 29, 1, 30));
    // 2026-10-25 02:30 happens twice; the first one is still CEST (+2).
    expect(zonedToUtc(2026, 10, 25, 2, 30, "Europe/Belgrade")).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });

  test("UTC to wall parts", () => {
    const p = zonedParts(Date.UTC(2026, 10, 11, 18, 15), "Asia/Kathmandu");
    expect(p).toMatchObject({ y: 2026, m: 11, d: 12, hh: 0, mm: 0, wd: 4 });
  });

  test("dates", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(parseYmd("2026-11-12")).toEqual({ y: 2026, m: 11, d: 12 });
    expect(parseYmd("2026-13-01")).toBeNull();
    expect(ymdOf(Date.UTC(2026, 10, 11, 23, 0), "Europe/Belgrade")).toBe("2026-11-12");
    expect(isValidTz("Europe/Belgrade")).toBe(true);
    expect(isValidTz("Mars/Olympus")).toBe(false);
  });
});
