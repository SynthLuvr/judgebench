import { describe, expect, it } from "vitest";

import {
  aucScore,
  brierScore,
  expectedCalibrationError,
  peakConfidence,
  percentile,
} from "../analysis/calibration.ts";

describe("peakConfidence", () => {
  it("is 0 at uniform and approaches 1 at certainty", () => {
    expect(peakConfidence([0.5, 0.5])).toBeCloseTo(0, 10);
    expect(peakConfidence([1, 0])).toBeCloseTo(1, 10);
    expect(peakConfidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0, 10);
  });

  it("scales the peak from uniform to certainty", () => {
    expect(peakConfidence([0.6, 0.4])).toBeCloseTo(0.2, 10);
    expect(peakConfidence([0.6, 0.2, 0.2])).toBeCloseTo(0.4, 10);
  });

  it("handles empty vectors", () => {
    expect(peakConfidence([])).toBe(0);
  });
});

describe("expectedCalibrationError", () => {
  it("is zero at a bin-midpoint calibration", () => {
    // 0.25-confidence points land in the 0.2–0.3 bin (midpoint 0.25);
    // 1 of 4 correct matches the midpoint exactly.
    const points = [
      { confidence: 0.25, correct: true },
      { confidence: 0.25, correct: false },
      { confidence: 0.25, correct: false },
      { confidence: 0.25, correct: false },
    ];
    expect(expectedCalibrationError(points)).toBeCloseTo(0, 10);
  });

  it("is large for confidently wrong predictions", () => {
    const points = Array.from({ length: 10 }, () => ({
      confidence: 0.99,
      correct: false,
    }));
    expect(expectedCalibrationError(points)).toBeGreaterThan(0.8);
  });
});

describe("brierScore", () => {
  it("is zero for a perfect deterministic prediction", () => {
    expect(
      brierScore([{ probs: [1, 0], humanLabel: "A" }], ["A", "B"]),
    ).toBeCloseTo(0, 10);
  });

  it("penalizes confident mistakes", () => {
    expect(
      brierScore([{ probs: [1, 0], humanLabel: "B" }], ["A", "B"]),
    ).toBeCloseTo(1, 10);
  });

  it("scores uniform guesses at disagreement", () => {
    const score = brierScore(
      [
        { probs: [0.5, 0.5], humanLabel: "A" },
        { probs: [0.5, 0.5], humanLabel: "B" },
      ],
      ["A", "B"],
    );
    expect(score).toBeCloseTo(0.25, 10);
  });
});

describe("aucScore", () => {
  it("is 1 for perfectly separated scores", () => {
    expect(
      aucScore([
        { score: 0.9, positive: true },
        { score: 0.1, positive: false },
      ]),
    ).toBe(1);
  });

  it("is 0.5 for identical distributions", () => {
    expect(
      aucScore([
        { score: 0.5, positive: true },
        { score: 0.5, positive: false },
      ]),
    ).toBe(0.5);
  });

  it("is null without both classes", () => {
    expect(aucScore([{ score: 0.9, positive: true }])).toBeNull();
  });
});

describe("percentile", () => {
  it("computes order statistics", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });
});
