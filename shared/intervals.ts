// Half-open intervals [start, end) in ms. Lists are kept sorted, non-overlapping and merged.

export type Iv = [number, number];
/** A hand-painted mark: [start, end, 1 = "can", 0 = "can't"]. */
export type Mark = [number, number, 0 | 1];

export function normalize(list: readonly Iv[]): Iv[] {
  const s = list.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as Iv).sort((x, y) => x[0] - y[0]);
  const out: Iv[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push(iv);
  }
  return out;
}

export function union(a: readonly Iv[], b: readonly Iv[]): Iv[] {
  return normalize([...a, ...b]);
}

/** Parts of `a` not covered by `b`. Both normalized. */
export function subtract(a: readonly Iv[], b: readonly Iv[]): Iv[] {
  const out: Iv[] = [];
  let j = 0;
  for (const [s0, e] of a) {
    let s = s0;
    while (j < b.length && b[j]![1] <= s) j++;
    let k = j;
    while (k < b.length && b[k]![0] < e) {
      const [bs, be] = b[k]!;
      if (bs > s) out.push([s, bs]);
      s = Math.max(s, be);
      if (s >= e) break;
      k++;
    }
    if (s < e) out.push([s, e]);
  }
  return out;
}

export function intersect(a: readonly Iv[], b: readonly Iv[]): Iv[] {
  const out: Iv[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i]![0], b[j]![0]), e = Math.min(a[i]![1], b[j]![1]);
    if (s < e) out.push([s, e]);
    if (a[i]![1] < b[j]![1]) i++; else j++;
  }
  return out;
}

export function clip(list: readonly Iv[], lo: number, hi: number): Iv[] {
  return intersect(list, [[lo, hi]]);
}

export function overlaps(list: readonly Iv[], s: number, e: number): boolean {
  for (const [a, b] of list) {
    if (a >= e) return false;
    if (b > s) return true;
  }
  return false;
}

export function totalLength(list: readonly Iv[]): number {
  return list.reduce((n, [a, b]) => n + (b - a), 0);
}

/** Paint [s, e) with a state (or clear it with null) over a list of marks. */
export function applyStroke(marks: readonly Mark[], s: number, e: number, state: 0 | 1 | null): Mark[] {
  if (e <= s) return marks.map((x) => [...x] as Mark);
  const out: Mark[] = [];
  for (const [a, b, st] of marks) {
    if (b <= s || a >= e) { out.push([a, b, st]); continue; }
    if (a < s) out.push([a, s, st]);
    if (b > e) out.push([e, b, st]);
  }
  if (state !== null) out.push([s, e, state]);
  out.sort((x, y) => x[0] - y[0]);
  const merged: Mark[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last[2] === m[2] && last[1] >= m[0]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m] as Mark);
  }
  return merged;
}

export function marksOf(marks: readonly Mark[], state: 0 | 1): Iv[] {
  return normalize(marks.filter((m) => m[2] === state).map(([a, b]) => [a, b] as Iv));
}
