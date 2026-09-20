import { mulberry32 } from "../core/rng";

type BootstrapResult = {
  readonly estimate: number;
  readonly ci95: readonly [number, number];
  readonly reps: number;
};

/** Mean of a sample vector, null when empty. */
const mean = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;

/** 2.5/97.5 percentile bounds of sorted replicate statistics. */
const percentileCi = (
  sorted: readonly number[],
  fallback: number,
): readonly [number, number] => [
  sorted[Math.floor(0.025 * sorted.length)] ?? fallback,
  sorted[Math.min(Math.ceil(0.975 * sorted.length) - 1, sorted.length - 1)] ??
    fallback,
];

/** Percentile bootstrap CI for the mean of a 0/1 (or numeric) vector. */
const bootstrapMean = (
  values: readonly number[],
  reps: number,
  seed: number,
): BootstrapResult | null => {
  const estimate = mean(values);
  if (estimate === null || reps <= 0) return null;
  const random = mulberry32(seed);
  const replicateMeans: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) {
      const draw = values[Math.floor(random() * values.length)];
      sum += draw ?? 0;
    }
    replicateMeans.push(sum / values.length);
  }
  replicateMeans.sort((a, b) => a - b);
  return { estimate, ci95: percentileCi(replicateMeans, estimate), reps };
};

/** Bootstrap CI for an arbitrary statistic computed over resampled indices. */
const bootstrapStatistic = (
  size: number,
  statistic: (indices: readonly number[]) => number | null,
  reps: number,
  seed: number,
): BootstrapResult | null => {
  if (size === 0 || reps <= 0) return null;
  const random = mulberry32(seed);
  const full = Array.from({ length: size }, (_, index) => index);
  const estimate = statistic(full);
  if (estimate === null) return null;
  const replicates: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const indices: number[] = [];
    for (let index = 0; index < size; index++)
      indices.push(Math.floor(random() * size));
    const value = statistic(indices);
    if (value !== null) replicates.push(value);
  }
  if (replicates.length === 0)
    return { estimate, ci95: [estimate, estimate], reps };
  replicates.sort((a, b) => a - b);
  return { estimate, ci95: percentileCi(replicates, estimate), reps };
};

export type { BootstrapResult };
export { bootstrapMean, bootstrapStatistic, mean };
