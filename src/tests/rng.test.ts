import { describe, expect, it } from "vitest";

import { hash01, mulberry32 } from "../core/rng.ts";

describe("rng", () => {
  it("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("mulberry32 differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it("hash01 is stable and within [0, 1)", () => {
    expect(hash01("abc")).toBe(hash01("abc"));
    expect(hash01("abc")).toBeGreaterThanOrEqual(0);
    expect(hash01("abc")).toBeLessThan(1);
    expect(hash01("abcd")).not.toBe(hash01("abc"));
  });
});
