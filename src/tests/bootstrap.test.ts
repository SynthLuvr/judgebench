import { describe, expect, it } from "vitest";

import {
  bootstrapMean,
  bootstrapStatistic,
  mean,
} from "../analysis/bootstrap.ts";

describe("mean", () => {
  it("averages and handles empties", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNull();
  });
});

describe("bootstrapMean", () => {
  it("brackets the estimate in its CI", () => {
    const values = [1, 0, 1, 1, 0, 1, 1, 1, 0, 1];
    const result = bootstrapMean(values, 500, 123);
    expect(result).not.toBeNull();
    const { estimate, ci95 } = result as NonNullable<typeof result>;
    expect(estimate).toBeCloseTo(0.7, 10);
    expect(ci95[0]).toBeLessThanOrEqual(estimate);
    expect(ci95[1]).toBeGreaterThanOrEqual(estimate);
  });

  it("is deterministic for a fixed seed", () => {
    const values = [0, 1, 1, 0, 1];
    expect(bootstrapMean(values, 100, 7)).toEqual(
      bootstrapMean(values, 100, 7),
    );
  });

  it("degenerates on constant vectors", () => {
    const result = bootstrapMean([1, 1, 1], 100, 1);
    expect(result?.ci95).toEqual([1, 1]);
  });

  it("returns null for empty input", () => {
    expect(bootstrapMean([], 100, 1)).toBeNull();
  });
});

describe("bootstrapStatistic", () => {
  it("returns null when the statistic itself is null", () => {
    expect(bootstrapStatistic(4, () => null, 100, 1)).toBeNull();
    expect(bootstrapStatistic(0, () => 1, 100, 1)).toBeNull();
  });

  it("bootstraps an arbitrary statistic", () => {
    const median = (indices: readonly number[]): number | null => {
      if (indices.length === 0) return null;
      const values = indices.map((index) => [10, 20, 30, 40][index] ?? 0);
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)] ?? null;
    };
    const result = bootstrapStatistic(4, median, 200, 99);
    expect(result).not.toBeNull();
    expect(result?.ci95[0]).toBeLessThanOrEqual(30);
    expect(result?.ci95[1]).toBeGreaterThanOrEqual(30);
  });
});
