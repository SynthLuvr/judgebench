import { describe, expect, it } from "vitest";
import pricing from "../pricing.json";

describe("pricing.json", () => {
  it("is priced per 1M tokens in USD", () => {
    expect(pricing.unit).toBe("per_1m_tokens");
    expect(pricing.currency).toBe("USD");
  });

  it("has dated entries with positive prices for every model", () => {
    const models = Object.entries(pricing.models);
    expect(models.length).toBeGreaterThan(0);
    for (const [id, entry] of models) {
      expect(id).toMatch(/^[a-z0-9._-]+\/[a-z0-9._-]+$/i);
      expect(entry.input).toBeGreaterThan(0);
      expect(entry.output).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(entry.as_of))).toBe(false);
    }
  });
});
