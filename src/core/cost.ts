type PriceEntry = {
  readonly input: number;
  readonly output: number;
  readonly as_of: string;
};

type PricingTable = {
  readonly currency: "USD";
  readonly unit: "per_1m_tokens";
  readonly models: Record<string, PriceEntry>;
};

// TODO Phase 1: pricing-table lookup, pilot-based cost projection for
// `estimate`, and the live --max-cost guard (exit code 4 on cumulative
// usage totals). analyze/report warn on missing or >90-day-old prices.
const projectCost = (_samples: number): number | null => null;

export type { PriceEntry, PricingTable };
export { projectCost };
