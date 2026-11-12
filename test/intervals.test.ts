import { describe, expect, test } from "bun:test";
import { applyStroke, clip, intersect, normalize, subtract, totalLength, union, type Mark } from "../shared/intervals";

describe("intervals", () => {
  test("normalize merges overlaps and touching ends, drops empty ones", () => {
    expect(normalize([[5, 7], [0, 2], [2, 3], [6, 9], [4, 4]])).toEqual([[0, 3], [5, 9]]);
  });

  test("set operations", () => {
    expect(subtract([[0, 10]], [[2, 4], [6, 8]])).toEqual([[0, 2], [4, 6], [8, 10]]);
    expect(subtract([[0, 10]], [[-5, 20]])).toEqual([]);
    expect(union([[0, 2]], [[1, 5], [7, 8]])).toEqual([[0, 5], [7, 8]]);
    expect(intersect([[0, 5], [8, 12]], [[3, 9]])).toEqual([[3, 5], [8, 9]]);
    expect(clip([[0, 5], [8, 12]], 4, 10)).toEqual([[4, 5], [8, 10]]);
    expect(totalLength([[0, 5], [8, 12]])).toBe(9);
  });

  test("strokes paint over marks and merge equal neighbours", () => {
    let m: Mark[] = [];
    m = applyStroke(m, 0, 10, 1);
    m = applyStroke(m, 4, 6, 0);
    expect(m).toEqual([[0, 4, 1], [4, 6, 0], [6, 10, 1]]);
    m = applyStroke(m, 4, 6, 1);
    expect(m).toEqual([[0, 10, 1]]);
    m = applyStroke(m, 2, 12, null);
    expect(m).toEqual([[0, 2, 1]]);
    m = applyStroke(m, 2, 5, 1);
    expect(m).toEqual([[0, 5, 1]]);
  });
});
