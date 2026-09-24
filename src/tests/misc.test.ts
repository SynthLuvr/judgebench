import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../analysis/metrics.ts";
import { loadEnvFile } from "../commands/context.ts";
import { renderCsv, renderMarkdown } from "../commands/report.ts";
import { type PricingTable, pricingAgeDays } from "../core/cost.ts";
import { packageVersion } from "../io/manifest.ts";

const require_ = createRequire(import.meta.url);

/** Ground truth: the installed adapter's package.json, not a pinned version. */
const installedAdapterVersion = (): string => {
  const pkg = JSON.parse(
    readFileSync(require_.resolve("system-one-adapter/package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
};

const tempPaths: string[] = [];

const tempFile = async (body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "judgebench-misc-"));
  tempPaths.push(dir);
  const path = join(dir, "f.env");
  await writeFile(path, body, "utf8");
  return path;
};

afterAll(async () => {
  for (const dir of tempPaths.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("packageVersion", () => {
  it("resolves installed package versions", () => {
    expect(packageVersion("system-one-adapter")).toBe(
      installedAdapterVersion(),
    );
  });

  it("returns unknown for unresolvable packages", () => {
    expect(packageVersion("definitely-not-a-package-xyz")).toBe("unknown");
  });
});

describe("loadEnvFile", () => {
  it("parses exports, quotes, and comments without overriding", async () => {
    process.env.JB_EXISTING = "original";
    const path = await tempFile(
      [
        "# comment",
        'export JB_QUOTED="hello world"',
        "JB_SINGLE='single'",
        "JB_EXISTING=overridden",
        "",
        "not-an-assignment",
      ].join("\n"),
    );
    const loaded = await loadEnvFile(path);
    expect(loaded.sort()).toEqual(["JB_QUOTED", "JB_SINGLE"]);
    expect(process.env.JB_QUOTED).toBe("hello world");
    expect(process.env.JB_SINGLE).toBe("single");
    expect(process.env.JB_EXISTING).toBe("original");
    delete process.env.JB_QUOTED;
    delete process.env.JB_SINGLE;
    delete process.env.JB_EXISTING;
  });
});

describe("pricingAgeDays", () => {
  it("treats unparsable dates as infinitely stale", () => {
    const table = { entry: { input: 1, output: 1, as_of: "not-a-date" } };
    expect(pricingAgeDays(table.entry, new Date("2026-01-01T00:00:00Z"))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("prices missing models as null", async () => {
    const { loadPricing, priceFor } = await import("../core/cost");
    const pricing = (await loadPricing()) as PricingTable;
    expect(priceFor(pricing, "nobody/none")).toBeNull();
  });
});

describe("report renderers with sparse data", () => {
  const analysis = {
    run_ids: ["r1"],
    created: "2026-01-01T00:00:00Z",
    dataset: "mtbench",
    adapter_version: "0.3.0",
    bootstrap_reps: 100,
    seed: 1,
    groups: [
      {
        config_hash: "h",
        judge: "custom/unscored-model",
        model: "unscored-model",
        axes: {
          answerMode: "discrete",
          structuredOutputs: false,
          labels: ["A", "B"],
          rubric: "default",
        },
        n_samples: 2,
        n_records: 4,
        n_errors: 1,
        n_pairs: 2,
        n_singles: 0,
        abstain_rate: 0.5,
        agreement: { point: 0.5, ci95: [0, 1] },
        agreement_single: { point: 0.5, ci95: [0, 1] },
        agreement_debiased: { point: 0.5, ci95: [0, 1] },
        tie_policy: { human_ties: 1, human_ties_matched: 0, excluded: 1 },
        raw_p_a: 0.5,
        flip_rate: { point: 0.5, ci95: [0, 1] },
        calibration: {
          ece: 0.2,
          brier: 0.4,
          flip_auc: null,
          n_pairs_scored: 2,
        },
        tokens: {
          input_total: 0,
          output_total: 0,
          input_per_judgment: 0,
          output_per_judgment: 0,
          cost_per_judgment_usd: null,
          cost_per_1k_judgments_usd: null,
          warnings: [
            "no pricing entry for custom/unscored-model — cost excluded",
          ],
        },
        latency_ms: { p50: 0, p95: 0 },
        reliability: {
          error_rate: 0.25,
          malformed_retry_rate: 0.5,
          mean_retries: 0.5,
          retry_reasons: { malformed_structure: 1 },
        },
        self_preference: null,
      },
    ],
    pareto: [
      {
        judge: "custom/unscored-model",
        axes: {
          answerMode: "discrete",
          structuredOutputs: false,
          labels: ["A", "B"],
          rubric: "default",
        },
        cost_per_1k_usd: null,
        agreement_debiased: 0.5,
        ci95: [0, 1],
      },
    ],
    canaries: null,
    hypotheses: {
      h1: { cheapest: null, agreement_span: [0.5, 0.5] },
      h2: [],
      h3: [{ judge: "custom/unscored-model", debiased_minus_single: 0 }],
      h4: { auc_above_half: 0, with_auc: 0 },
    },
  } as unknown as AnalysisResult;

  it("renders markdown with null costs and warnings", () => {
    const markdown = renderMarkdown(analysis);
    expect(markdown).toContain("custom/unscored-model");
    expect(markdown).toContain("—");
    expect(markdown).toContain("no matched on/off pair");
    expect(markdown).toContain("n/a (no pricing)");
    expect(markdown).toContain("warning:");
  });

  it("renders csv with empty cells for nulls", () => {
    const csv = renderCsv(analysis);
    expect(csv).toContain(
      "custom/unscored-model,discrete,false,A/B,default,0.5",
    );
    expect(csv).toContain(",0.5,0.5,"); // flip_auc + cost nulls land as empty cells
  });
});
