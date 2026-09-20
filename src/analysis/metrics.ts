import type { HumanLabel } from "../core/config";
import { costOfUsage, type PricingTable, pricingWarnings } from "../core/cost";
import type { Sample } from "../core/dataset";
import type { AdapterUsage, JudgmentRecord } from "../core/judge";
import { canonicalLabel } from "../core/swap";
import { bootstrapMean, bootstrapStatistic } from "./bootstrap";
import {
  aucScore,
  brierScore,
  expectedCalibrationError,
  peakConfidence,
  percentile,
} from "./calibration";

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

type GroupKey = string;

const groupKeyOf = (record: JudgmentRecord): GroupKey =>
  `${record.judge}|${record.config_hash}`;

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

const argmaxOf = (
  probs: readonly number[],
  labels: readonly HumanLabel[],
): HumanLabel | null => {
  if (probs.length === 0) return null;
  let best = 0;
  for (let index = 1; index < probs.length; index++)
    if (probs[index] > probs[best]) best = index;
  return labels[best] ?? null;
};

const averageVectors = (
  vectors: readonly (readonly number[])[],
): readonly number[] => {
  const width = Math.max(0, ...vectors.map((vector) => vector.length));
  const out: number[] = [];
  for (let index = 0; index < width; index++) {
    let sum = 0;
    let count = 0;
    for (const vector of vectors) {
      const value = vector[index];
      if (value !== undefined) {
        sum += value;
        count += 1;
      }
    }
    out.push(count === 0 ? 0 : sum / count);
  }
  return out;
};

const toLabels = (labels: readonly string[]): readonly HumanLabel[] =>
  labels as readonly HumanLabel[];

/** Whether a sample's human tie is scorable under this cell's label set. */
const humanTieScorable = (labels: readonly string[]): boolean =>
  labels.includes("tie");

type AssembledSample = {
  readonly human: HumanLabel;
  readonly first: JudgmentRecord;
  readonly second: JudgmentRecord | null;
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
    const [first, second, ...rest] = sorted;
    if (first === undefined) continue;
    assemblies.push({
      human: first.human_label,
      first,
      second: second ?? (rest.length > 0 ? (rest[0] ?? null) : null),
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
  const averaged = averageVectors(vectors);
  return { decision: argmaxOf(averaged, labels), probs: averaged };
};

const singleDecisionOf = (assembly: AssembledSample): HumanLabel | null =>
  canonicalLabel(assembly.first.raw_label as HumanLabel, assembly.first.order);

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
  const labels = toLabels(axes.labels);
  const assemblies = assembleSamples(records);
  const pairs = assemblies.filter((assembly) => assembly.second !== null);

  // Tie policy: human ties are excluded when the cell cannot answer tie.
  const scorableTies = humanTieScorable(axes.labels);
  const scored = assemblies.filter(
    (assembly) => scorableTies || assembly.human !== "tie",
  );
  const excluded = assemblies.length - scored.length;
  const humanTies = assemblies.filter(
    (assembly) => assembly.human === "tie",
  ).length;
  const humanTiesMatched = scored.filter(
    (assembly) =>
      assembly.human === "tie" && canonicalDecisionOf(assembly) === "tie",
  ).length;

  const agreementVector: number[] = [];
  const singleVector: number[] = [];
  const debiasedVector: number[] = [];
  const calibrationPoints: { confidence: number; correct: boolean }[] = [];
  const brierPredictions: { probs: readonly number[]; humanLabel: string }[] =
    [];
  const rawPa: number[] = [];
  for (const assembly of scored) {
    const decision = canonicalDecisionOf(assembly);
    if (decision !== null)
      agreementVector.push(decision === assembly.human ? 1 : 0);
    const single = singleDecisionOf(assembly);
    if (single !== null) singleVector.push(single === assembly.human ? 1 : 0);
    const { decision: debiased, probs } = debiasedDecisionOf(assembly, labels);
    if (debiased !== null) {
      debiasedVector.push(debiased === assembly.human ? 1 : 0);
      if (probs !== null) {
        calibrationPoints.push({
          confidence: peakConfidence(probs),
          correct: debiased === assembly.human,
        });
        brierPredictions.push({ probs, humanLabel: assembly.human });
      }
    }
  }
  for (const record of records)
    if (record.probs !== null && record.probs.length > 0)
      rawPa.push(record.probs[0]);

  const flipBooleans = pairs.map((assembly) => {
    const first = singleDecisionOf(assembly);
    const second =
      assembly.second === null
        ? null
        : canonicalLabel(
            assembly.second.raw_label as HumanLabel,
            assembly.second.order,
          );
    return first !== null && second !== null && first !== second;
  });
  const aucInput = pairs.map((assembly, index) => ({
    score: peakConfidence(assembly.first.probs ?? []),
    positive: flipBooleans[index] ?? false,
  }));

  const hasUsage = (
    record: JudgmentRecord,
  ): record is JudgmentRecord & { usage: AdapterUsage } =>
    record.usage !== null;
  const usable = records.filter(hasUsage);
  const tokenBreakdown = usable.map((record) =>
    costOfUsage(pricing, record.judge, record.usage),
  );
  const inputTotal = tokenBreakdown.reduce(
    (sum, entry) => sum + (entry?.input_tokens ?? 0),
    0,
  );
  const outputTotal = tokenBreakdown.reduce(
    (sum, entry) => sum + (entry?.output_tokens ?? 0),
    0,
  );
  const costTotal = tokenBreakdown.reduce(
    (sum, entry) => sum + (entry?.cost_usd ?? 0),
    0,
  );
  const perJudgment = usable.length === 0 ? null : costTotal / usable.length;
  const warnings = pricingWarnings(
    pricing,
    [...new Set(records.map((record) => record.judge))],
    options.now,
  );
  const latencies = usable
    .map((record) => record.usage.latency)
    .filter((value) => value > 0);
  const retryReasons: Record<string, number> = {};
  for (const record of records)
    for (const [category] of record.retry_reasons)
      retryReasons[category] = (retryReasons[category] ?? 0) + 1;

  const abstains = pairs.filter(
    (assembly) => canonicalDecisionOf(assembly) === null,
  ).length;

  let selfPreference: GroupMetrics["self_preference"] = null;
  if (options.selfPreferenceFilter) {
    const slice = scored.filter((assembly) => {
      const sample = samples.get(assembly.first.sample_id);
      const modelA = sample?.model_a ?? "";
      const modelB = sample?.model_b ?? "";
      return modelA === modelB;
    });
    if (slice.length > 0) {
      const hits = slice.filter(
        (assembly) => canonicalDecisionOf(assembly) === assembly.human,
      );
      const debiasedHits = slice.filter(
        (assembly) =>
          debiasedDecisionOf(assembly, labels).decision === assembly.human,
      );
      selfPreference = {
        n_samples: slice.length,
        agreement: hits.length / slice.length,
        agreement_debiased: debiasedHits.length / slice.length,
      };
    }
  }

  const modelsUsed = [
    ...new Set(records.map((record) => record.model).filter((m) => m !== "")),
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
    agreement: ciMetric(agreementVector, options.bootstrapReps, options.seed),
    agreement_single: ciMetric(
      singleVector,
      options.bootstrapReps,
      options.seed + 1,
    ),
    agreement_debiased: ciMetric(
      debiasedVector,
      options.bootstrapReps,
      options.seed + 2,
    ),
    tie_policy: {
      human_ties: humanTies,
      human_ties_matched: humanTiesMatched,
      excluded,
    },
    raw_p_a: rates(rawPa),
    flip_rate: ciMetric(
      flipBooleans.map((flipped) => (flipped ? 1 : 0)),
      options.bootstrapReps,
      options.seed + 3,
    ),
    calibration: {
      ece: expectedCalibrationError(calibrationPoints),
      brier: brierScore(brierPredictions, axes.labels),
      flip_auc: aucCi(aucInput, options),
      n_pairs_scored: pairs.length,
    },
    tokens: {
      input_total: inputTotal,
      output_total: outputTotal,
      input_per_judgment: usable.length === 0 ? 0 : inputTotal / usable.length,
      output_per_judgment:
        usable.length === 0 ? 0 : outputTotal / usable.length,
      cost_per_judgment_usd: perJudgment,
      cost_per_1k_judgments_usd:
        perJudgment === null ? null : perJudgment * 1000,
      warnings,
    },
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    reliability: {
      error_rate:
        records.length === 0
          ? 0
          : (records.length - usable.length) / records.length,
      malformed_retry_rate:
        usable.length === 0
          ? 0
          : usable.reduce(
              (sum, record) => sum + record.usage.n_retries_malformed_structure,
              0,
            ) / usable.length,
      mean_retries:
        usable.length === 0
          ? 0
          : usable.reduce((sum, record) => sum + record.usage.n_retries, 0) /
            usable.length,
      retry_reasons: retryReasons,
    },
    self_preference: selfPreference,
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
  return {
    point,
    ci95: boot?.ci95 ?? [point, point],
  };
};

const computeCanaries = (
  records: readonly JudgmentRecord[],
  options: MetricOptions,
): CanariesMetrics | null => {
  const template = records[0];
  if (template === undefined) return null;
  const labels = toLabels(template.cell.labels);
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
  const grouped = new Map<GroupKey, JudgmentRecord[]>();
  for (const record of records) {
    const key = groupKeyOf(record);
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
export {
  assembleSamples,
  canonicalDecisionOf,
  computeCanaries,
  computeGroup,
  computeHypotheses,
  computeMetrics,
  debiasedDecisionOf,
  singleDecisionOf,
};
