import { t, type Lang } from "./i18n";
import { DAY, HOUR, MIN, zonedParts } from "./time";

const cache = new Map<string, Intl.DateTimeFormat>();
function f(lang: Lang, tz: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = lang + tz + JSON.stringify(o);
  let x = cache.get(k);
  if (!x) {
    x = new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", { timeZone: tz, ...o });
    cache.set(k, x);
  }
  return x;
}

const loc = (lang: Lang) => (lang === "ru" ? "ru-RU" : "en-GB");

export const fmtTime = (ms: number, tz: string, lang: Lang) => f(lang, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
export const fmtDay = (ms: number, tz: string, lang: Lang) => f(lang, tz, { weekday: "short", day: "numeric", month: "short" }).format(ms);
export const fmtDayLong = (ms: number, tz: string, lang: Lang) => f(lang, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(ms);

/** "Fri 20 Nov, 18:00 – 19:30", or across days "Fri 20 Nov, 18:00 – Sat 21 Nov, 10:00". */
export function fmtRange(s: number, e: number, tz: string, lang: Lang): string {
  const a = zonedParts(s, tz), b = zonedParts(e - 1, tz);
  const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
  if (sameDay) return `${fmtDay(s, tz, lang)}, ${fmtTime(s, tz, lang)}–${fmtTime(e, tz, lang)}`;
  return `${fmtDay(s, tz, lang)}, ${fmtTime(s, tz, lang)} – ${fmtDay(e, tz, lang)}, ${fmtTime(e, tz, lang)}`;
}

/** A calendar date (YYYY-MM-DD) as "20 Nov 2026" / "20 нояб. 2026 г." regardless of zones. */
export function fmtYmd(ymd: string, lang: Lang, withWeekday = false): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const o: Intl.DateTimeFormatOptions = { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" };
  if (withWeekday) o.weekday = "short";
  return new Intl.DateTimeFormat(loc(lang), o).format(Date.UTC(y, m - 1, d, 12));
}

/** "12–18 Nov 2026", "28 Nov – 3 Dec 2026". */
export function fmtYmdRange(a: string, b: string, lang: Lang): string {
  const d = (ymd: string) => { const [y, m, dd] = ymd.split("-").map(Number) as [number, number, number]; return Date.UTC(y, m - 1, dd, 12); };
  const f = new Intl.DateTimeFormat(loc(lang), { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  return a === b ? f.format(d(a)) : f.formatRange(d(a), d(b));
}

export function fmtDuration(min: number, lang: Lang): string {
  const days = Math.floor(min / 1440), hours = Math.floor((min % 1440) / 60), mins = min % 60;
  const parts: string[] = [];
  if (days) parts.push(t(lang, "d_days", { n: days }));
  if (hours) parts.push(t(lang, "d_hours", { n: hours }));
  if (mins || !parts.length) parts.push(t(lang, "d_minutes", { n: mins }));
  return parts.join(" ");
}

export function fmtAgo(ms: number, now: number, lang: Lang): string {
  const d = Math.max(0, now - ms);
  if (d < MIN) return t(lang, "ago_now");
  if (d < HOUR) return t(lang, "ago_min", { n: Math.floor(d / MIN) });
  if (d < DAY) return t(lang, "ago_h", { n: Math.floor(d / HOUR) });
  return t(lang, "ago_d", { n: Math.floor(d / DAY) });
}

/** A readable zone name: "Europe/Belgrade" -> "Belgrade (UTC+1)". */
export function fmtTz(tz: string, at: number): string {
  const city = (tz.split("/").pop() ?? tz).replace(/_/g, " ");
  const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${city} (${off.replace("GMT", "UTC") || "UTC"})`;
}
