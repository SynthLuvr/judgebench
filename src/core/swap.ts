import type { HumanLabel } from "./config";
import { hash01, mulberry32 } from "./rng";

type SwapOrder = "AB" | "BA";

/** The canonical decision a swap protocol produces for one sample. */
type SwapDecision = {
  /** Position-space labels of both passes in judgment order. */
  readonly labels: readonly (HumanLabel | null)[];
  /** Consistency-rule label: the matching label, or abstain on a flip. */
  readonly label: HumanLabel | "abstain";
  /** Probabilities-mode decision: average canonical P across orders, argmax. */
  readonly debiased: HumanLabel | null;
  /** True when the two orders disagreed on their argmax. */
  readonly flipped: boolean;
};

/** Orders one sample is judged in, randomized deterministically by seed. */
const ordersFor = (
  sampleId: string,
  swap: "both" | "single",
  seed: number,
): readonly SwapOrder[] => {
  const random = mulberry32(seed ^ (hash01(sampleId) * 0xffff_ffff));
  const first: SwapOrder = random() < 0.5 ? "AB" : "BA";
  if (swap === "single") return [first];
  return [first, first === "AB" ? "BA" : "AB"];
};

/** Map a position-space label to the canonical response it refers to. */
const canonicalLabel = (label: HumanLabel, order: SwapOrder): HumanLabel => {
  if (label === "tie") return "tie";
  if (order === "AB") return label;
  return label === "A" ? "B" : "A";
};

/** Argmax label of a canonical-space probability vector, or null when empty. */
const argmaxLabel = (
  probs: readonly number[],
  labels: readonly HumanLabel[],
): HumanLabel | null => {
  if (probs.length === 0) return null;
  let bestIndex = 0;
  for (let index = 1; index < probs.length; index++)
    if (probs[index] > probs[bestIndex]) bestIndex = index;
  return labels[bestIndex] ?? null;
};

const meanProbabilities = (
  vectors: readonly (readonly number[])[],
): readonly number[] => {
  if (vectors.length === 0) return [];
  const width = Math.max(...vectors.map((vector) => vector.length));
  const averaged: number[] = [];
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
    averaged.push(count === 0 ? 0 : sum / count);
  }
  return averaged;
};

/**
 * Decide one sample's canonical outcome from its per-order judgments.
 *
 * Discrete/consistency rule: matching canonical labels → that label;
 * a mismatch → abstain with `flipped` logged. Probabilities mode: the
 * debiased decision averages canonical P across orders before argmax.
 */
const decideSwap = (
  judgments: readonly {
    readonly order: SwapOrder;
    readonly raw_label: HumanLabel | null;
    readonly probs: readonly number[] | null;
  }[],
  labels: readonly HumanLabel[],
): SwapDecision | null => {
  const present = judgments.filter((judgment) => judgment.raw_label !== null);
  if (present.length === 0) return null;
  const canonical = present.map((judgment) =>
    canonicalLabel(judgment.raw_label as HumanLabel, judgment.order),
  );
  const consistent = canonical.every((label) => label === canonical[0]);
  const debiasedVectors = present
    .filter((judgment) => judgment.probs !== null)
    .map((judgment) => judgment.probs as readonly number[]);
  const debiased =
    debiasedVectors.length === 0
      ? null
      : argmaxLabel(meanProbabilities(debiasedVectors), labels);
  const argmaxes = debiasedVectors
    .map((vector) => argmaxLabel(vector, labels))
    .filter((label): label is HumanLabel => label !== null);
  const flipped = argmaxes.length >= 2 && new Set(argmaxes).size > 1;
  return {
    labels: present.map((judgment) => judgment.raw_label),
    label: consistent ? canonical[0] : "abstain",
    debiased,
    flipped: flipped || !consistent,
  };
};

export type { SwapDecision, SwapOrder };
export {
  argmaxLabel,
  canonicalLabel,
  decideSwap,
  meanProbabilities,
  mulberry32,
  ordersFor,
};
