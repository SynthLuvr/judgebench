type CalibrationResult = {
  readonly ece: number;
  readonly brier: number;
};

// TODO Phase 2: ECE + Brier on choice probabilities; confidence-vs-flip
// AUC. The harness recomputes peak-based confidence locally because
// choiceConfidence is not exported from the adapter's public surface
// (verified against src/index.ts).
export type { CalibrationResult };
