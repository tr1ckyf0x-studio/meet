// Time-zone math on top of Intl, shared by the server and the browser bundle.
// All instants are milliseconds since the epoch (UTC). Wall times are { y, m (1-12), d, hh, mm }.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface Parts { y: number; m: number; d: number; hh: number; mm: number; wd: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a zone. `wd` is 0 = Sunday. */
export function zonedParts(ms: number, tz: string): Parts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour! % 24, mm: +p.minute!, wd: WD[p.weekday!] ?? 0 };
}

// Offsets change only on quarter-hour boundaries of UTC (every zone's offset and transition time is a multiple of
// 15 minutes), so one lookup per zone and quarter hour is enough. Bounded, cleared when full.
const offCache = new Map<string, number>();
const QUARTER = 15 * 60_000;

/** Offset of the zone from UTC at an instant, in ms (positive east of Greenwich). */
export function tzOffset(ms: number, tz: string): number {
  const key = tz + "|" + Math.floor(ms / QUARTER);
  const hit = offCache.get(key);
  if (hit !== undefined) return hit;
  const off = computeOffset(ms, tz);
  if (offCache.size > 50_000) offCache.clear();
  offCache.set(key, off);
  return off;
}

function computeOffset(ms: number, tz: string): number {
  const t = Math.floor(ms / 1000) * 1000;
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(t))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
  return asUtc - t;
}

/**
 * The instant at which the wall clock in `tz` shows the given time. A time skipped by a DST jump maps to
 * the same distance after the jump (02:30 → 03:30); a repeated time maps to its first occurrence.
 */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = tzOffset(guess - tzOffset(guess, tz), tz);
  const o2 = tzOffset(guess - o1, tz);
  if (o1 === o2) {
    // In an overlap both offsets are consistent; prefer the earlier instant (the larger offset).
    const before = tzOffset(guess - o1 - 3 * HOUR, tz);
    if (before > o1 && tzOffset(guess - before, tz) === before) return guess - before;
    return guess - o1;
  }
  // Gap: no offset is consistent. Use the offset from before the jump, which lands after it.
  return guess - Math.min(o1, o2);
}

export function isValidTz(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export interface Ymd { y: number; m: number; d: number }

export function parseYmd(s: string): Ymd | null {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!r) return null;
  const y = +r[1]!, m = +r[2]!, d = +r[3]!;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtYmd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function addDays(ymd: string, n: number): string {
  const p = parseYmd(ymd);
  if (!p) throw new Error(`bad date ${ymd}`);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return fmtYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Calendar date of an instant in a zone, as YYYY-MM-DD. */
export function ymdOf(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return fmtYmd(p.y, p.m, p.d);
}

/** Midnight at the start of a calendar date in a zone. */
export function startOfDay(ymd: string, tz: string): number {
  const p = parseYmd(ymd);
  if (!p) throw new Error(`bad date ${ymd}`);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
}

/** Days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const pa = parseYmd(a), pb = parseYmd(b);
  if (!pa || !pb) throw new Error("bad date");
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY);
}
