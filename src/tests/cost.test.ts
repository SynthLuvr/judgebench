import { describe, expect, it } from "vitest";

import {
  contentHash,
  costOfUsage,
  loadPricing,
  priceFor,
  pricingAgeDays,
  pricingWarnings,
  projectCost,
} from "../core/cost.ts";

describe("pricing table", () => {
  it("loads and prices models per 1M tokens", async () => {
    const pricing = await loadPricing();
    const entry = priceFor(pricing, "openai/gpt-4o-mini");
    expect(entry).not.toBeNull();
    expect(entry?.input).toBeGreaterThan(0);
  });

  it("computes retry-inclusive judgment cost", async () => {
    const pricing = await loadPricing();
    const entry = priceFor(pricing, "openai/gpt-4o-mini");
    if (entry === null) throw new Error("missing entry");
    const cost = costOfUsage(pricing, "openai/gpt-4o-mini", {
      input_tokens_total: 1_000_000,
      output_tokens_total: 1_000_000,
    });
    expect(cost?.cost_usd).toBeCloseTo(entry.input + entry.output, 6);
  });

  it("treats unknown models as zero cost with token accounting", async () => {
    const pricing = await loadPricing();
    const cost = costOfUsage(pricing, "custom/whatever", {
      input_tokens_total: 123,
      output_tokens_total: 45,
    });
    expect(cost?.cost_usd).toBe(0);
    expect(cost?.input_tokens).toBe(123);
  });

  it("projects cost from pilot means", async () => {
    const pricing = await loadPricing();
    const projected = projectCost(
      pricing,
      "openai/gpt-4o-mini",
      { input_tokens_total: 10_000, output_tokens_total: 500 },
      2_000,
    );
    const entry = priceFor(pricing, "openai/gpt-4o-mini");
    if (entry === null) throw new Error("missing entry");
    expect(projected).toBeCloseTo(
      ((10_000 * entry.input + 500 * entry.output) / 1e6) * 2_000,
      6,
    );
  });

  it("warns on missing and stale prices", async () => {
    const pricing = await loadPricing();
    const warnings = pricingWarnings(
      pricing,
      ["custom/unknown-model", "openai/gpt-4o-mini"],
      new Date("2027-01-01T00:00:00Z"),
    );
    expect(
      warnings.some((warning) => warning.includes("custom/unknown-model")),
    ).toBe(true);
    expect(warnings.some((warning) => warning.includes("days old"))).toBe(true);
    expect(
      pricingWarnings(
        pricing,
        ["openai/gpt-4o-mini"],
        new Date("2024-08-01T00:00:00Z"),
      ),
    ).toEqual([]);
  });

  it("measures pricing age from as_of", async () => {
    const pricing = await loadPricing();
    const entry = priceFor(pricing, "openai/gpt-4o-mini");
    if (entry === null) throw new Error("missing entry");
    const age = pricingAgeDays(entry, new Date(`${entry.as_of}T00:00:00Z`));
    expect(age).toBeCloseTo(0, 5);
  });
});

describe("contentHash", () => {
  it("hashes content stably", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
