type SwapOrder = "AB" | "BA";

type SwapDecision = {
  readonly label: "A" | "B" | "tie" | "abstain";
  readonly flipped: boolean;
};

// TODO Phase 1: order randomization, swap protocol, debias math.
// Consistent pairs → that label; inconsistent pairs → abstain + logged
// flip; in probabilities mode, average P(A) across orders before argmax.
const decideSwap = (_ab: unknown, _ba: unknown): SwapDecision | null => null;

export type { SwapDecision, SwapOrder };
export { decideSwap };
