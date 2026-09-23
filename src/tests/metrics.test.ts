import { describe, expect, it } from "vitest";
import { computeMetrics } from "../analysis/metrics.ts";
import type { CellSpec } from "../core/config.ts";
import { loadPricing } from "../core/cost.ts";
import type { Sample } from "../core/dataset.ts";
import type { JudgmentRecord } from "../core/judge.ts";

const CELL: CellSpec = {
  answerMode: "probabilities",
  structuredOutputs: true,
  labels: ["A", "B", "tie"],
  rubric: null,
};

const record = (overrides: Partial<JudgmentRecord>): JudgmentRecord => ({
  sample_id: "s1",
  judge: "openai/test-model",
  config_hash: "h1",
  order: "AB",
  raw_label: "A",
  probs: [0.8, 0.15, 0.05],
  confidence: 0.7,
  swap_consistent: null,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_total: 100,
    output_tokens_total: 20,
    n_retries: 0,
    n_retries_malformed_structure: 0,
    latency: 10,
  },
  retry_reasons: [],
  n_retries_malformed_structure: 0,
  model: "test-model",
  ts: "2026-01-01T00:00:00Z",
  cell: CELL,
  human_label: "A",
  error: null,
  error_type: null,
  llm_attempt: null,
  ...overrides,
});

const SAMPLES: readonly Sample[] = [
  {
    id: "s1",
    prompt: "p1",
    response_a: "a",
    response_b: "b",
    human_label: "A",
    model_a: "same",
    model_b: "same",
  },
  {
    id: "s2",
    prompt: "p2",
    response_a: "a",
    response_b: "b",
    human_label: "B",
    model_a: "x",
    model_b: "y",
  },
];

const analyze = async (
  records: readonly JudgmentRecord[],
  options: { selfPreferenceFilter?: boolean; dataset?: string } = {},
) => {
  const pricing = await loadPricing();
  const samples = new Map(SAMPLES.map((sample) => [sample.id, sample]));
  return computeMetrics(
    records,
    samples,
    ["test-run"],
    options.dataset ?? "canaries",
    "0.3.0",
    {
      bootstrapReps: 100,
      seed: 1,
      selfPreferenceFilter: options.selfPreferenceFilter ?? false,
      now: new Date("2026-01-01T00:00:00Z"),
    },
    pricing,
  );
};

describe("computeMetrics", () => {
  it("scores perfect swap-consistent agreement", async () => {
    const records = [
      record({
        sample_id: "s1",
        order: "AB",
        raw_label: "A",
        probs: [0.9, 0.08, 0.02],
      }),
      record({
        sample_id: "s1",
        order: "BA",
        raw_label: "B",
        probs: [0.9, 0.08, 0.02],
      }),
      record({
        sample_id: "s2",
        order: "AB",
        raw_label: "B",
        probs: [0.1, 0.85, 0.05],
        human_label: "B",
      }),
      record({
        sample_id: "s2",
        order: "BA",
        raw_label: "A",
        probs: [0.1, 0.85, 0.05],
        human_label: "B",
      }),
    ];
    const analysis = await analyze(records);
    const group = analysis.groups[0];
    if (group === undefined) throw new Error("no group");
    expect(group.agreement.point).toBe(1);
    expect(group.agreement_debiased.point).toBe(1);
    expect(group.agreement_single.point).toBe(1);
    expect(group.flip_rate.point).toBe(0);
    expect(group.abstain_rate).toBe(0);
    expect(group.n_pairs).toBe(2);
    expect(group.raw_p_a).toBeCloseTo(0.5, 5);
    expect(group.calibration.ece).toBeLessThan(0.35);
    expect(group.calibration.brier).toBeLessThan(0.2);
  });

  it("counts flips and abstains on inconsistent orders", async () => {
    const records = [
      // s1: AB says A (canonical A), BA says A (canonical B) → flip/abstain.
      record({
        sample_id: "s1",
        order: "AB",
        raw_label: "A",
        probs: [0.9, 0.1, 0],
      }),
      record({
        sample_id: "s1",
        order: "BA",
        raw_label: "A",
        probs: [0.2, 0.8, 0],
      }),
      // s2: consistent B (human B).
      record({
        sample_id: "s2",
        order: "AB",
        raw_label: "B",
        probs: [0.05, 0.95, 0],
        human_label: "B",
      }),
      record({
        sample_id: "s2",
        order: "BA",
        raw_label: "A",
        probs: [0.05, 0.95, 0],
        human_label: "B",
      }),
    ];
    const analysis = await analyze(records);
    const group = analysis.groups[0];
    if (group === undefined) throw new Error("no group");
    expect(group.flip_rate.point).toBe(0.5);
    expect(group.abstain_rate).toBe(0.5);
    // Agreement excludes the abstain; debiased resolves it via averaging.
    expect(group.agreement.point).toBe(1);
    expect(group.agreement_debiased.point).toBe(1);
  });

  it("excludes human ties when the cell cannot answer tie", async () => {
    const twoLabelCell = { ...CELL, labels: ["A", "B"] as const };
    const records = [
      record({
        sample_id: "s1",
        order: "AB",
        raw_label: "A",
        probs: [0.9, 0.1],
        cell: twoLabelCell,
        human_label: "tie",
      }),
      record({
        sample_id: "s2",
        order: "AB",
        raw_label: "B",
        probs: [0.1, 0.9],
        cell: twoLabelCell,
        human_label: "B",
      }),
    ];
    const analysis = await analyze(records);
    const group = analysis.groups[0];
    if (group === undefined) throw new Error("no group");
    expect(group.tie_policy.excluded).toBe(1);
    expect(group.tie_policy.human_ties).toBe(1);
    expect(group.agreement.point).toBe(1);
  });

  it("separates groups by judge and config hash", async () => {
    const records = [
      record({ sample_id: "s1", judge: "openai/a", config_hash: "h1" }),
      record({
        sample_id: "s1",
        judge: "openai/b",
        config_hash: "h2",
        order: "BA",
        raw_label: "B",
        probs: [0.2, 0.7, 0.1],
      }),
    ];
    const analysis = await analyze(records);
    expect(analysis.groups).toHaveLength(2);
    expect(analysis.groups.map((group) => group.judge).sort()).toEqual([
      "openai/a",
      "openai/b",
    ]);
  });

  it("tracks reliability and token economics", async () => {
    const records = [
      record({
        sample_id: "s1",
        judge: "openai/gpt-4o-mini",
        config_hash: "h1",
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          input_tokens_total: 1500,
          output_tokens_total: 250,
          n_retries: 1,
          n_retries_malformed_structure: 1,
          latency: 1.5,
        },
        retry_reasons: [["malformed_structure", "boom"]],
      }),
      record({
        sample_id: "s2",
        order: "AB",
        judge: "openai/gpt-4o-mini",
        config_hash: "h1",
        error: "boom",
        error_type: "APIError",
        usage: null,
        probs: null,
        raw_label: null,
      }),
    ];
    const analysis = await analyze(records);
    const group = analysis.groups[0];
    if (group === undefined) throw new Error("no group");
    expect(group.n_errors).toBe(1);
    expect(group.reliability.error_rate).toBeCloseTo(0.5, 5);
    expect(group.reliability.malformed_retry_rate).toBe(1);
    expect(group.reliability.retry_reasons.malformed_structure).toBe(1);
    expect(group.tokens.input_total).toBe(1500);
    expect(group.tokens.output_total).toBe(250);
    expect(group.tokens.cost_per_1k_judgments_usd).not.toBeNull();
    if (group.tokens.cost_per_1k_judgments_usd !== null)
      expect(group.tokens.cost_per_1k_judgments_usd).toBeGreaterThan(0);
    // The adapter reports seconds; latency_ms must convert to milliseconds.
    expect(group.latency_ms.p50).toBe(1500);
  });

  it("computes the self-preference slice on demand", async () => {
    const records = [
      // s1 has model_a == model_b; judge correct.
      record({ sample_id: "s1", order: "AB", raw_label: "A" }),
      // s2 does not.
      record({ sample_id: "s2", order: "AB", raw_label: "B" }),
    ];
    const analysis = await analyze(records, { selfPreferenceFilter: true });
    const group = analysis.groups[0];
    if (group === undefined) throw new Error("no group");
    expect(group.self_preference).not.toBeNull();
    expect(group.self_preference?.n_samples).toBe(1);
    expect(group.self_preference?.agreement).toBe(1);
  });

  it("scores canaries injection robustness", async () => {
    const records = [
      record({
        sample_id: "s1",
        order: "AB",
        raw_label: "A",
        probs: [0.9, 0.1, 0],
      }),
      record({
        sample_id: "s2",
        order: "AB",
        raw_label: "B",
        probs: [0.1, 0.9, 0],
      }),
    ];
    const analysis = await analyze(records, { dataset: "canaries" });
    expect(analysis.canaries).not.toBeNull();
    expect(analysis.canaries?.injection_followed_rate.point).toBeCloseTo(
      0.5,
      5,
    );
    expect(analysis.canaries?.robustness_rate.point).toBeCloseTo(0.5, 5);
  });

  it("fills hypotheses and pareto data", async () => {
    const records = [
      record({
        sample_id: "s1",
        judge: "openai/gpt-4o-mini",
        config_hash: "h1",
        order: "AB",
        raw_label: "A",
        probs: [0.9, 0.08, 0.02],
      }),
      record({
        sample_id: "s1",
        judge: "openai/gpt-4o-mini",
        config_hash: "h1",
        order: "BA",
        raw_label: "B",
        probs: [0.9, 0.08, 0.02],
      }),
      record({
        sample_id: "s1",
        judge: "openai/gpt-4o-mini",
        config_hash: "h2",
        order: "AB",
        raw_label: "A",
        probs: [0.6, 0.3, 0.1],
        cell: { ...CELL, structuredOutputs: false },
      }),
    ];
    const analysis = await analyze(records);
    expect(analysis.pareto.length).toBe(2);
    expect(analysis.hypotheses.h1.cheapest).not.toBeNull();
    expect(analysis.hypotheses.h2).toHaveLength(1);
    expect(analysis.hypotheses.h3).toHaveLength(2);
  });
});
