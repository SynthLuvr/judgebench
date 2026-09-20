import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type } from "arktype";

/** Maximum age (days) of a pricing entry before analyze/report warn. */
const PRICING_MAX_AGE_DAYS = 90;

const PriceEntrySchema = type({
  input: "number > 0",
  output: "number > 0",
  as_of: "string",
}).onUndeclaredKey("reject");

const PricingTableSchema = type({
  currency: "'USD'",
  unit: "'per_1m_tokens'",
  models: type({ "[string]": PriceEntrySchema }),
}).onUndeclaredKey("reject");

type PriceEntry = typeof PriceEntrySchema.infer;
type PricingTable = typeof PricingTableSchema.infer;

type UsageLike = {
  readonly input_tokens_total?: number;
  readonly output_tokens_total?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
};

type CostBreakdown = {
  readonly cost_usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
};

const pricingTablePath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "pricing.json");

let cachedTable: PricingTable | null = null;

const loadPricing = async (): Promise<PricingTable> => {
  if (cachedTable !== null) return cachedTable;
  const path = pricingTablePath();
  const parsed = PricingTableSchema(JSON.parse(await readFile(path, "utf8")));
  if (parsed instanceof type.errors)
    throw new Error(`pricing table ${path} is invalid: ${parsed.summary}`);
  cachedTable = parsed;
  return parsed;
};

/** Price a model id ("provider/model") against the table. */
const priceFor = (table: PricingTable, modelId: string): PriceEntry | null =>
  table.models[modelId] ?? null;

const pricingAgeDays = (entry: PriceEntry, now: Date): number => {
  const asOf = Date.parse(
    entry.as_of.endsWith("Z") ? entry.as_of : `${entry.as_of}T00:00:00Z`,
  );
  if (Number.isNaN(asOf)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - asOf) / 86_400_000;
};

/** Warnings for missing or stale prices, used by analyze/report/estimate. */
const pricingWarnings = (
  table: PricingTable,
  modelIds: readonly string[],
  now: Date,
): readonly string[] => {
  const warnings: string[] = [];
  for (const modelId of new Set(modelIds)) {
    const entry = priceFor(table, modelId);
    if (entry === null) {
      warnings.push(
        `no pricing entry for ${modelId} — cost excluded from totals`,
      );
      continue;
    }
    const age = pricingAgeDays(entry, now);
    if (age > PRICING_MAX_AGE_DAYS)
      warnings.push(
        `pricing for ${modelId} is ${Math.round(age)} days old (as_of ${entry.as_of}) — verify against provider billing`,
      );
  }
  return warnings;
};

/** Cost of one judgment's cumulative (retry-inclusive) token usage. */
const costOfUsage = (
  table: PricingTable,
  modelId: string,
  usage: UsageLike,
): CostBreakdown | null => {
  const entry = priceFor(table, modelId);
  const inputTokens = usage.input_tokens_total ?? usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens_total ?? usage.output_tokens ?? 0;
  if (entry === null)
    return {
      cost_usd: 0,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
  return {
    cost_usd:
      (inputTokens / 1e6) * entry.input + (outputTokens / 1e6) * entry.output,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
};

/** Project a run's cost from measured pilot usage per judgment. */
const projectCost = (
  table: PricingTable,
  modelId: string,
  meanUsage: UsageLike,
  judgments: number,
): number | null => {
  const per = costOfUsage(table, modelId, meanUsage);
  if (per === null) return null;
  return per.cost_usd * judgments;
};

/** SHA-256 of file content, hex; used for dataset identity in manifests. */
const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export type { CostBreakdown, PriceEntry, PricingTable, UsageLike };
export {
  contentHash,
  costOfUsage,
  loadPricing,
  PRICING_MAX_AGE_DAYS,
  priceFor,
  pricingAgeDays,
  pricingTablePath,
  pricingWarnings,
  projectCost,
};
