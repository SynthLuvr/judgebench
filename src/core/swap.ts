import type { HumanLabel } from "./config.ts";
import { hash01, mulberry32 } from "./rng.ts";

type SwapOrder = "AB" | "BA";

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

/** Element-wise mean of possibly ragged vectors; missing entries count 0. */
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

export type { SwapOrder };
export { argmaxLabel, canonicalLabel, meanProbabilities, ordersFor };
