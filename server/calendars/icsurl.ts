import type { Iv } from "../../shared/intervals";
import { FetchError, parseUserUrl, safeFetch, type GuardOptions } from "./fetchguard";
import { busyFromIcs } from "./parse";

export interface IcsSecret { url: string }

export function normalizeIcsUrl(input: string): string {
  return parseUserUrl(input).toString();
}

export async function icsBusy(secret: IcsSecret, lo: number, hi: number, tz: string, guard: GuardOptions): Promise<Iv[]> {
  const r = await safeFetch(secret.url, { headers: { accept: "text/calendar, */*;q=0.5", "user-agent": "meet-calendar/1" } }, guard);
  if (r.status === 401 || r.status === 403) throw new FetchError("auth");
  if (r.status === 404 || r.status === 410) throw new FetchError("not_found");
  if (r.status !== 200) throw new FetchError(`http_${r.status}`);
  if (!r.text.includes("BEGIN:VCALENDAR")) throw new FetchError("not_calendar");
  try {
    return busyFromIcs(r.text, lo, hi, tz);
  } catch {
    throw new FetchError("bad_calendar");
  }
}
