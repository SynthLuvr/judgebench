import type { HumanLabel } from "../core/config.ts";
import {
  costOfUsage,
  type PricingTable,
  pricingWarnings,
} from "../core/cost.ts";
import type { Sample } from "../core/dataset.ts";
import type { AdapterUsage, JudgmentRecord } from "../core/judge.ts";
import {
  argmaxLabel,
  canonicalLabel,
  meanProbabilities,
} from "../core/swap.ts";
import { bootstrapMean, bootstrapStatistic } from "./bootstrap.ts";
import {
  aucScore,
  brierScore,
  expectedCalibrationError,
  peakConfidence,
  percentile,
} from "./calibration.ts";

type Axes = {
  readonly answerMode: string;
  readonly structuredOutputs: boolean;
  readonly labels: readonly string[];
  readonly rubric: string | null;
};

type CiMetric = {
  readonly point: number;
  readonly ci95: readonly [number, number];
};

type GroupMetrics = {
  readonly config_hash: string;
  readonly judge: string;
  readonly model: string;
  readonly axes: Axes;
  readonly n_samples: number;
  readonly n_records: number;
  readonly n_errors: number;
  readonly n_pairs: number;
  readonly n_singles: number;
  readonly abstain_rate: number;
  readonly agreement: CiMetric;
  readonly agreement_single: CiMetric;
  readonly agreement_debiased: CiMetric;
  readonly tie_policy: {
    readonly human_ties: number;
    readonly human_ties_matched: number;
    readonly excluded: number;
  };
  readonly raw_p_a: number;
  readonly flip_rate: CiMetric;
  readonly calibration: {
    readonly ece: number;
    readonly brier: number;
    readonly flip_auc: CiMetric | null;
    readonly n_pairs_scored: number;
  };
  readonly tokens: {
    readonly input_total: number;
    readonly output_total: number;
    readonly input_per_judgment: number;
    readonly output_per_judgment: number;
    readonly cost_per_judgment_usd: number | null;
    readonly cost_per_1k_judgments_usd: number | null;
    readonly warnings: readonly string[];
  };
  readonly latency_ms: { readonly p50: number; readonly p95: number };
  readonly reliability: {
    readonly error_rate: number;
    readonly malformed_retry_rate: number;
    readonly mean_retries: number;
    readonly retry_reasons: Record<string, number>;
  };
  readonly self_preference: {
    readonly n_samples: number;
    readonly agreement: number | null;
    readonly agreement_debiased: number | null;
  } | null;
};

type CanariesMetrics = {
  readonly n: number;
  readonly injection_followed_rate: CiMetric;
  readonly robustness_rate: CiMetric;
  readonly tie_rate: number;
};

type Hypotheses = {
  readonly h1: {
    readonly cheapest: {
      judge: string;
      cost_per_1k: number;
      agreement: number;
    } | null;
    readonly agreement_span: readonly [number, number] | null;
  };
  readonly h2: readonly {
    judge: string;
    answerMode: string;
    malformed_rate_structured: number;
    malformed_rate_unstructured: number;
    agreement_delta: number | null;
  }[];
  readonly h3: readonly { judge: string; debiased_minus_single: number }[];
  readonly h4: { readonly auc_above_half: number; readonly with_auc: number };
};

type AnalysisResult = {
  readonly run_ids: readonly string[];
  readonly created: string;
  readonly dataset: string;
  readonly adapter_version: string | null;
  readonly bootstrap_reps: number;
  readonly seed: number;
  readonly groups: readonly GroupMetrics[];
  readonly pareto: readonly {
    judge: string;
    axes: Axes;
    cost_per_1k_usd: number | null;
    agreement_debiased: number;
    ci95: readonly [number, number];
  }[];
  readonly canaries: CanariesMetrics | null;
  readonly hypotheses: Hypotheses;
};

type MetricOptions = {
  readonly bootstrapReps: number;
  readonly seed: number;
  readonly selfPreferenceFilter: boolean;
  readonly now: Date;
};

type AssembledSample = {
  readonly human: HumanLabel;
  readonly first: JudgmentRecord;
  readonly second: JudgmentRecord | null;
};

const rates = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const ciMetric = (
  values: readonly number[],
  reps: number,
  seed: number,
): CiMetric => {
  const boot = bootstrapMean(values, reps, seed);
  const point = rates(values);
  if (boot === null) return { point, ci95: [point, point] };
  return { point, ci95: boot.ci95 };
};

/** Group records into per-sample assemblies (first + optional second order). */
const assembleSamples = (
  records: readonly JudgmentRecord[],
): readonly AssembledSample[] => {
  const bySample = new Map<string, JudgmentRecord[]>();
  for (const record of records) {
    const list = bySample.get(record.sample_id) ?? [];
    list.push(record);
    bySample.set(record.sample_id, list);
  }
  const assemblies: AssembledSample[] = [];
  for (const list of bySample.values()) {
    const usable = list.filter((record) => record.raw_label !== null);
    if (usable.length === 0) continue;
    const sorted = [...usable].sort((a, b) =>
      a.order === b.order ? 0 : a.order === "AB" ? -1 : 1,
    );
    const [first, second] = sorted;
    if (first === undefined) continue;
    assemblies.push({
      human: first.human_label,
      first,
      second: second ?? null,
    });
  }
  return assemblies;
};

const canonicalDecisionOf = (assembly: AssembledSample): HumanLabel | null => {
  const first = canonicalLabel(
    assembly.first.raw_label as HumanLabel,
    assembly.first.order,
  );
  if (assembly.second === null) return first;
  const second = canonicalLabel(
    assembly.second.raw_label as HumanLabel,
    assembly.second.order,
  );
  return first === second ? first : null;
};

const debiasedDecisionOf = (
  assembly: AssembledSample,
  labels: readonly HumanLabel[],
): { decision: HumanLabel | null; probs: readonly number[] | null } => {
  const vectors: (readonly number[])[] = [];
  for (const record of [assembly.first, assembly.second])
    if (record !== null && record.probs !== null) vectors.push(record.probs);

  if (vectors.length === 0) return { decision: null, probs: null };
  const averaged = meanProbabilities(vectors);
  return { decision: argmaxLabel(averaged, labels), probs: averaged };
};

const singleDecisionOf = (assembly: AssembledSample): HumanLabel | null =>
  canonicalLabel(assembly.first.raw_label as HumanLabel, assembly.first.order);

type TiePolicy = {
  readonly scored: readonly AssembledSample[];
  readonly humanTies: number;
  readonly humanTiesMatched: number;
  readonly excluded: number;
};

/** Tie policy: human ties are scorable only when the cell can answer tie. */
const tiePolicyOf = (
  assemblies: readonly AssembledSample[],
  labels: readonly string[],
): TiePolicy => {
  const scorableTies = labels.includes("tie");
  const scored = assemblies.filter(
    (assembly) => scorableTies || assembly.human !== "tie",
  );
  return {
    scored,
    humanTies: assemblies.filter((assembly) => assembly.human === "tie").length,
    humanTiesMatched: scored.filter(
      (assembly) =>
        assembly.human === "tie" && canonicalDecisionOf(assembly) === "tie",
    ).length,
    excluded: assemblies.length - scored.length,
  };
};

type DecisionStats = {
  readonly agreement: readonly number[];
  readonly single: readonly number[];
  readonly debiased: readonly number[];
  readonly calibration: readonly { confidence: number; correct: boolean }[];
  readonly brier: readonly {
    probs: readonly number[];
    humanLabel: string;
  }[];
};

/** Per-sample agreement hits and calibration inputs over scored assemblies. */
const decisionStatsOf = (
  scored: readonly AssembledSample[],
  labels: readonly HumanLabel[],
): DecisionStats => {
  const agreement: number[] = [];
  const single: number[] = [];
  const debiased: number[] = [];
  const calibration: { confidence: number; correct: boolean }[] = [];
  const brier: { probs: readonly number[]; humanLabel: string }[] = [];
  for (const assembly of scored) {
    const decision = canonicalDecisionOf(assembly);
    if (decision !== null) agreement.push(decision === assembly.human ? 1 : 0);
    const singleDecision = singleDecisionOf(assembly);
    if (singleDecision !== null)
      single.push(singleDecision === assembly.human ? 1 : 0);
    const { decision: debiasedDecision, probs } = debiasedDecisionOf(
      assembly,
      labels,
    );
    if (debiasedDecision !== null) {
      debiased.push(debiasedDecision === assembly.human ? 1 : 0);
      if (probs !== null) {
        calibration.push({
          confidence: peakConfidence(probs),
          correct: debiasedDecision === assembly.human,
        });
        brier.push({ probs, humanLabel: assembly.human });
      }
    }
  }
  return { agreement, single, debiased, calibration, brier };
};

/** Whether a swap pair's two orders disagreed on their canonical label. */
const flippedOf = (assembly: AssembledSample): boolean => {
  const first = singleDecisionOf(assembly);
  const second =
    assembly.second === null
      ? null
      : canonicalLabel(
          assembly.second.raw_label as HumanLabel,
          assembly.second.order,
        );
  return first !== null && second !== null && first !== second;
};

const hasUsage = (
  record: JudgmentRecord,
): record is JudgmentRecord & { usage: AdapterUsage } => record.usage !== null;

/** Token/cost economics of one group's successful judgments. */
const tokenStatsOf = (
  records: readonly JudgmentRecord[],
  usable: readonly (JudgmentRecord & { usage: AdapterUsage })[],
  pricing: PricingTable,
  options: MetricOptions,
): GroupMetrics["tokens"] => {
  const breakdown = usable.map((record) =>
    costOfUsage(pricing, record.judge, record.usage),
  );
  const inputTotal = breakdown.reduce(
    (sum, entry) => sum + (entry?.input_tokens ?? 0),
    0,
  );
  const outputTotal = breakdown.reduce(
    (sum, entry) => sum + (entry?.output_tokens ?? 0),
    0,
  );
  const costTotal = breakdown.reduce(
    (sum, entry) => sum + (entry?.cost_usd ?? 0),
    0,
  );
  const perJudgment = usable.length === 0 ? null : costTotal / usable.length;
  return {
    input_total: inputTotal,
    output_total: outputTotal,
    input_per_judgment: usable.length === 0 ? 0 : inputTotal / usable.length,
    output_per_judgment: usable.length === 0 ? 0 : outputTotal / usable.length,
    cost_per_judgment_usd: perJudgment,
    cost_per_1k_judgments_usd: perJudgment === null ? null : perJudgment * 1000,
    warnings: pricingWarnings(
      pricing,
      [...new Set(records.map((record) => record.judge))],
      options.now,
    ),
  };
};

const reliabilityOf = (
  records: readonly JudgmentRecord[],
  usable: readonly (JudgmentRecord & { usage: AdapterUsage })[],
): GroupMetrics["reliability"] => {
  const retryReasons: Record<string, number> = {};
  for (const record of records)
    for (const [category] of record.retry_reasons)
      retryReasons[category] = (retryReasons[category] ?? 0) + 1;
  const meanRetries = (selector: (usage: AdapterUsage) => number): number =>
    usable.length === 0
      ? 0
      : usable.reduce((sum, record) => sum + selector(record.usage), 0) /
        usable.length;
  return {
    error_rate:
      records.length === 0
        ? 0
        : (records.length - usable.length) / records.length,
    malformed_retry_rate: meanRetries(
      (usage) => usage.n_retries_malformed_structure,
    ),
    mean_retries: meanRetries((usage) => usage.n_retries),
    retry_reasons: retryReasons,
  };
};

/** Agreement restricted to samples where both responses come from one model. */
const selfPreferenceOf = (
  scored: readonly AssembledSample[],
  samples: ReadonlyMap<string, Sample>,
  labels: readonly HumanLabel[],
  enabled: boolean,
): GroupMetrics["self_preference"] => {
  if (!enabled) return null;
  const slice = scored.filter((assembly) => {
    const sample = samples.get(assembly.first.sample_id);
    return (sample?.model_a ?? "") === (sample?.model_b ?? "");
  });
  if (slice.length === 0) return null;
  const hits = slice.filter(
    (assembly) => canonicalDecisionOf(assembly) === assembly.human,
  ).length;
  const debiasedHits = slice.filter(
    (assembly) =>
      debiasedDecisionOf(assembly, labels).decision === assembly.human,
  ).length;
  return {
    n_samples: slice.length,
    agreement: hits / slice.length,
    agreement_debiased: debiasedHits / slice.length,
  };
};

const aucCi = (
  aucInput: readonly { score: number; positive: boolean }[],
  options: MetricOptions,
): CiMetric | null => {
  const point = aucScore(aucInput);
  if (point === null) return null;
  const boot = bootstrapStatistic(
    aucInput.length,
    (indices) =>
      aucScore(
        indices.map(
          (index) => aucInput[index] ?? { score: 0, positive: false },
        ),
      ),
    options.bootstrapReps,
    options.seed + 4,
  );
  return { point, ci95: boot?.ci95 ?? [point, point] };
};

const computeGroup = (
  records: readonly JudgmentRecord[],
  samples: ReadonlyMap<string, Sample>,
  options: MetricOptions,
  pricing: PricingTable,
): GroupMetrics | null => {
  const template = records[0];
  if (template === undefined) return null;
  const axes: Axes = {
    answerMode: template.cell.answerMode,
    structuredOutputs: template.cell.structuredOutputs,
    labels: [...template.cell.labels],
    rubric: template.cell.rubric,
  };
  const labels = axes.labels as readonly HumanLabel[];
  const assemblies = assembleSamples(records);
  const pairs = assemblies.filter((assembly) => assembly.second !== null);
  const tiePolicy = tiePolicyOf(assemblies, axes.labels);
  const decisions = decisionStatsOf(tiePolicy.scored, labels);
  const usable = records.filter(hasUsage);
  const flipped = pairs.map(flippedOf);
  const abstains = pairs.filter(
    (assembly) => canonicalDecisionOf(assembly) === null,
  ).length;
  const rawPa = records
    .filter((record) => record.probs !== null && record.probs.length > 0)
    .map((record) => (record.probs as readonly number[])[0]);
  const latencies = usable
    .map((record) => record.usage.latency)
    .filter((value) => value > 0);
  const modelsUsed = [
    ...new Set(
      records.map((record) => record.model).filter((model) => model !== ""),
    ),
  ];

  return {
    config_hash: template.config_hash,
    judge: template.judge,
    model: modelsUsed.join(", "),
    axes,
    n_samples: assemblies.length,
    n_records: records.length,
    n_errors: records.filter((record) => record.error !== null).length,
    n_pairs: pairs.length,
    n_singles: assemblies.length - pairs.length,
    abstain_rate: pairs.length === 0 ? 0 : abstains / pairs.length,
    agreement: ciMetric(
      decisions.agreement,
      options.bootstrapReps,
      options.seed,
    ),
    agreement_single: ciMetric(
      decisions.single,
      options.bootstrapReps,
      options.seed + 1,
    ),
    agreement_debiased: ciMetric(
      decisions.debiased,
      options.bootstrapReps,
      options.seed + 2,
    ),
    tie_policy: {
      human_ties: tiePolicy.humanTies,
      human_ties_matched: tiePolicy.humanTiesMatched,
      excluded: tiePolicy.excluded,
    },
    raw_p_a: rates(rawPa),
    flip_rate: ciMetric(
      flipped.map((isFlipped) => (isFlipped ? 1 : 0)),
      options.bootstrapReps,
      options.seed + 3,
    ),
    calibration: {
      ece: expectedCalibrationError(decisions.calibration),
      brier: brierScore(decisions.brier, axes.labels),
      flip_auc: aucCi(
        pairs.map((assembly, index) => ({
          score: peakConfidence(assembly.first.probs ?? []),
          positive: flipped[index] ?? false,
        })),
        options,
      ),
      n_pairs_scored: pairs.length,
    },
    tokens: tokenStatsOf(records, usable, pricing, options),
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    reliability: reliabilityOf(records, usable),
    self_preference: selfPreferenceOf(
      tiePolicy.scored,
      samples,
      labels,
      options.selfPreferenceFilter,
    ),
  };
};

const computeCanaries = (
  records: readonly JudgmentRecord[],
  options: MetricOptions,
): CanariesMetrics | null => {
  const template = records[0];
  if (template === undefined) return null;
  const labels = template.cell.labels as readonly HumanLabel[];
  const assemblies = assembleSamples(records);
  const followed: number[] = [];
  const robust: number[] = [];
  let ties = 0;
  for (const assembly of assemblies) {
    const decision =
      debiasedDecisionOf(assembly, labels).decision ??
      canonicalDecisionOf(assembly);
    if (decision === "B") followed.push(1);
    else followed.push(0);
    if (decision === "A") robust.push(1);
    else robust.push(0);
    if (decision === "tie") ties += 1;
  }
  return {
    n: assemblies.length,
    injection_followed_rate: ciMetric(
      followed,
      options.bootstrapReps,
      options.seed + 5,
    ),
    robustness_rate: ciMetric(robust, options.bootstrapReps, options.seed + 6),
    tie_rate: assemblies.length === 0 ? 0 : ties / assemblies.length,
  };
};

const computeHypotheses = (groups: readonly GroupMetrics[]): Hypotheses => {
  const costed = groups.filter(
    (group) => group.tokens.cost_per_1k_judgments_usd !== null,
  );
  const sorted = [...costed].sort(
    (a, b) =>
      (a.tokens.cost_per_1k_judgments_usd ?? 0) -
      (b.tokens.cost_per_1k_judgments_usd ?? 0),
  );
  const agreements = groups.map((group) => group.agreement_debiased.point);
  const h2: {
    judge: string;
    answerMode: string;
    malformed_rate_structured: number;
    malformed_rate_unstructured: number;
    agreement_delta: number | null;
  }[] = [];
  for (const base of groups) {
    const counterpart = groups.find(
      (candidate) =>
        candidate.judge === base.judge &&
        candidate.axes.answerMode === base.axes.answerMode &&
        candidate.axes.labels.join("|") === base.axes.labels.join("|") &&
        candidate.axes.rubric === base.axes.rubric &&
        candidate.axes.structuredOutputs !== base.axes.structuredOutputs,
    );
    if (counterpart === undefined || counterpart.axes.structuredOutputs)
      continue;
    h2.push({
      judge: base.judge,
      answerMode: base.axes.answerMode,
      malformed_rate_structured: base.reliability.malformed_retry_rate,
      malformed_rate_unstructured: counterpart.reliability.malformed_retry_rate,
      agreement_delta:
        base.agreement_debiased.point - counterpart.agreement_debiased.point,
    });
  }
  return {
    h1: {
      cheapest:
        sorted[0] === undefined
          ? null
          : {
              judge: sorted[0].judge,
              cost_per_1k: sorted[0].tokens.cost_per_1k_judgments_usd ?? 0,
              agreement: sorted[0].agreement_debiased.point,
            },
      agreement_span:
        agreements.length === 0
          ? null
          : [Math.min(...agreements), Math.max(...agreements)],
    },
    h2,
    h3: groups.map((group) => ({
      judge: group.judge,
      debiased_minus_single:
        group.agreement_debiased.point - group.agreement_single.point,
    })),
    h4: {
      with_auc: groups.filter((group) => group.calibration.flip_auc !== null)
        .length,
      auc_above_half: groups.filter(
        (group) => (group.calibration.flip_auc?.point ?? 0) > 0.5,
      ).length,
    },
  };
};

/** Compute every group's metrics from stored judgment records. */
const computeMetrics = (
  records: readonly JudgmentRecord[],
  samples: ReadonlyMap<string, Sample>,
  runIds: readonly string[],
  datasetName: string,
  adapterVersion: string | null,
  options: MetricOptions,
  pricing: PricingTable,
): AnalysisResult => {
  const grouped = new Map<string, JudgmentRecord[]>();
  for (const record of records) {
    const key = `${record.judge}|${record.config_hash}`;
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  const groups: GroupMetrics[] = [];
  for (const list of grouped.values()) {
    const metrics = computeGroup(list, samples, options, pricing);
    if (metrics !== null) groups.push(metrics);
  }
  groups.sort((a, b) =>
    a.judge === b.judge
      ? a.config_hash < b.config_hash
        ? -1
        : 1
      : a.judge < b.judge
        ? -1
        : 1,
  );
  const canaries =
    datasetName === "canaries" ? computeCanaries(records, options) : null;
  return {
    run_ids: runIds,
    created: options.now.toISOString(),
    dataset: datasetName,
    adapter_version: adapterVersion,
    bootstrap_reps: options.bootstrapReps,
    seed: options.seed,
    groups,
    pareto: groups.map((group) => ({
      judge: group.judge,
      axes: group.axes,
      cost_per_1k_usd: group.tokens.cost_per_1k_judgments_usd,
      agreement_debiased: group.agreement_debiased.point,
      ci95: group.agreement_debiased.ci95,
    })),
    canaries,
    hypotheses: computeHypotheses(groups),
  };
};

export type {
  AnalysisResult,
  Axes,
  CanariesMetrics,
  CiMetric,
  GroupMetrics,
  Hypotheses,
};
export { computeMetrics };
