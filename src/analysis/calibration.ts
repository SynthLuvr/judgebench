const peakConfidence = (probs: readonly number[]): number => {
  if (probs.length === 0) return 0;
  const peak = Math.max(...probs);
  const uniform = 1 / probs.length;
  if (probs.length === 1 || peak === uniform) return 0;
  return (peak - uniform) / (1 - uniform);
};

/**
 * Peak-based choice confidence, recomputed locally: the adapter computes the
 * same quantity for `ChoiceResponse.confidence` but does not export the
 * helper (`choiceConfidence` is internal to its src/, verified against the
 * package's public `src/index.ts`), so the harness carries its own copy.
 */

/** Expected calibration error over equal-width bins. */
const expectedCalibrationError = (
  points: readonly { confidence: number; correct: boolean }[],
  bins = 10,
): number => {
  if (points.length === 0 || bins <= 0) return 0;
  const binSums = Array.from({ length: bins }, () => ({ sum: 0, count: 0 }));
  for (const point of points) {
    const clamped = Math.min(Math.max(point.confidence, 0), 1);
    const index = Math.min(Math.floor(clamped * bins), bins - 1);
    const bin = binSums[index];
    bin.sum += point.correct ? 1 : 0;
    bin.count += 1;
  }
  let ece = 0;
  for (const bin of binSums) {
    if (bin.count === 0) continue;
    const binAccuracy = bin.sum / bin.count;
    const binConfidence = (binSums.indexOf(bin) + 0.5) / bins;
    ece += (bin.count / points.length) * Math.abs(binAccuracy - binConfidence);
  }
  return ece;
};

/** Multi-class Brier score of predicted probability vectors. */
const brierScore = (
  predictions: readonly { probs: readonly number[]; humanLabel: string }[],
  labels: readonly string[],
): number => {
  if (predictions.length === 0) return 0;
  let total = 0;
  for (const prediction of predictions) {
    let sampleScore = 0;
    for (const [index, label] of labels.entries()) {
      const actual = prediction.humanLabel === label ? 1 : 0;
      const predicted = prediction.probs[index] ?? 0;
      sampleScore += (predicted - actual) ** 2;
    }
    total += sampleScore / labels.length;
  }
  return total / predictions.length;
};

/** Rank-based AUC (Mann–Whitney): P(score of a positive exceeds a negative). */
const aucScore = (
  scores: readonly { score: number; positive: boolean }[],
): number | null => {
  const positives = scores
    .filter((entry) => entry.positive)
    .map((entry) => entry.score);
  const negatives = scores
    .filter((entry) => !entry.positive)
    .map((entry) => entry.score);
  if (positives.length === 0 || negatives.length === 0) return null;
  let greater = 0;
  let equal = 0;
  for (const positive of positives)
    for (const negative of negatives)
      if (positive > negative) greater += 1;
      else if (positive === negative) equal += 1;

  return (greater + 0.5 * equal) / (positives.length * negatives.length);
};

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    Math.ceil(fraction * sorted.length) - 1,
    sorted.length - 1,
  );
  return sorted[Math.max(index, 0)];
};

export {
  aucScore,
  brierScore,
  expectedCalibrationError,
  peakConfidence,
  percentile,
};
