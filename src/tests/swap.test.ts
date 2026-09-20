import { describe, expect, it } from "vitest";

import {
  argmaxLabel,
  canonicalLabel,
  meanProbabilities,
  ordersFor,
} from "../core/swap";

describe("ordersFor", () => {
  it("returns both orders deterministically for the same seed", () => {
    expect(ordersFor("s1", "both", 7)).toEqual(ordersFor("s1", "both", 7));
  });

  it("returns exactly one order in single mode", () => {
    const orders = ordersFor("s1", "single", 7);
    expect(orders).toHaveLength(1);
    expect(["AB", "BA"]).toContain(orders[0]);
  });

  it("covers both orders in both mode", () => {
    const orders = ordersFor("s1", "both", 7);
    expect(new Set(orders)).toEqual(new Set(["AB", "BA"]));
  });

  it("varies across samples so position assignment is randomized", () => {
    const firsts = new Set(
      Array.from(
        { length: 20 },
        (_, index) => ordersFor(`s${index}`, "single", 7)[0],
      ),
    );
    expect(firsts.size).toBe(2);
  });
});

describe("canonicalLabel", () => {
  it("maps position labels through the order", () => {
    expect(canonicalLabel("A", "AB")).toBe("A");
    expect(canonicalLabel("B", "AB")).toBe("B");
    expect(canonicalLabel("A", "BA")).toBe("B");
    expect(canonicalLabel("B", "BA")).toBe("A");
    expect(canonicalLabel("tie", "BA")).toBe("tie");
  });
});

describe("argmaxLabel", () => {
  it("picks the argmax label", () => {
    expect(argmaxLabel([0.2, 0.7, 0.1], ["A", "B", "tie"])).toBe("B");
    expect(argmaxLabel([], ["A", "B"])).toBeNull();
  });
});

describe("meanProbabilities", () => {
  it("averages vectors element-wise", () => {
    const averaged = meanProbabilities([
      [0.6, 0.4],
      [0.2, 0.8],
    ]);
    expect(averaged[0]).toBeCloseTo(0.4, 10);
    expect(averaged[1]).toBeCloseTo(0.6, 10);
  });

  it("handles ragged vectors", () => {
    const ragged = meanProbabilities([
      [1, 0, 0.5],
      [0.5, 0.5],
    ]);
    expect(ragged).toEqual([0.75, 0.25, 0.5]);
  });
});
