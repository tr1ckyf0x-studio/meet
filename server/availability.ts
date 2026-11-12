import { clip, intersect, marksOf, subtract, union, type Iv, type Mark } from "../shared/intervals";

export interface MemberInput {
  lo: number;
  hi: number;
  /** The member uses at least one calendar in this group. */
  hasCalendars: boolean;
  /** Busy time from those calendars, normalized. */
  calendarBusy: Iv[];
  marks: Mark[];
}

/**
 * When a member cannot meet, inside [lo, hi). With calendars the base is "free except busy"; without, the
 * member is unavailable until they paint when they can. Painted marks override the base either way.
 */
export function memberUnavailable(m: MemberInput): Iv[] {
  let u: Iv[] = m.hasCalendars ? clip(m.calendarBusy, m.lo, m.hi) : [[m.lo, m.hi]];
  u = subtract(u, marksOf(m.marks, 1));
  u = union(u, marksOf(m.marks, 0));
  return clip(u, m.lo, m.hi);
}

export interface SuggestMember { id: string; responded: boolean; unavailable: Iv[] }
export interface Window { start: number; end: number; missingIds: string[] }
export interface Suggestions {
  /** How many responded members each window leaves out (0 = everyone can). */
  missing: number;
  /** Members who have not marked anything yet; they are left out of the computation. */
  pending: string[];
  windows: Window[];
}

const MAX_WINDOWS = 12;

/** Free windows at least `durationMs` long: for everyone if possible, else for all but one, then two. */
export function suggest(members: SuggestMember[], lo: number, hi: number, durationMs: number): Suggestions {
  const responded = members.filter((m) => m.responded);
  const pending = members.filter((m) => !m.responded).map((m) => m.id);
  if (!responded.length || hi <= lo) return { missing: 0, pending, windows: [] };

  const free = new Map(responded.map((m) => [m.id, subtract([[lo, hi]], m.unavailable)]));
  const ids = responded.map((m) => m.id);
  const common = (without: Set<string>): Iv[] => {
    let acc: Iv[] = [[lo, hi]];
    for (const id of ids) if (!without.has(id)) acc = intersect(acc, free.get(id)!);
    return acc;
  };
  const longEnough = (list: Iv[], missingIds: string[]): Window[] =>
    list.filter(([s, e]) => e - s >= durationMs).map(([start, end]) => ({ start, end, missingIds }));

  const exact = longEnough(common(new Set()), []);
  if (exact.length || ids.length === 1) return { missing: 0, pending, windows: exact.slice(0, MAX_WINDOWS) };

  const levels: string[][][] = [ids.map((a) => [a])];
  if (ids.length >= 3 && ids.length <= 25) {
    const pairs: string[][] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i]!, ids[j]!]);
    levels.push(pairs);
  }
  for (const [i, sets] of levels.entries()) {
    const found = sets.flatMap((without) => longEnough(common(new Set(without)), without));
    if (found.length) {
      found.sort((a, b) => a.start - b.start || b.end - a.end);
      return { missing: i + 1, pending, windows: found.slice(0, MAX_WINDOWS) };
    }
  }
  return { missing: 0, pending, windows: [] };
}
