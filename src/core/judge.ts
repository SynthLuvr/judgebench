import type { SwapOrder } from "./swap";

type AnswerMode = "probabilities" | "discrete";

type JudgmentRecord = {
  readonly sample_id: string;
  readonly judge: string;
  readonly config_hash: string;
  readonly order: SwapOrder;
  readonly raw_label: string;
  readonly probs: readonly number[] | null;
  readonly confidence: number | null;
  readonly swap_consistent: boolean | null;
  readonly usage: Record<string, unknown> | null;
  readonly retry_reasons: readonly string[];
  readonly n_retries_malformed_structure: number;
  readonly model: string;
  readonly ts: string;
};

// TODO Phase 1: state + questions builder; one systemOne call per judgment
// through the public system-one-adapter surface only. The adapter's
// `usage` + `debug` telemetry land in `usage` verbatim.
const judgeSample = async (): Promise<JudgmentRecord | null> => null;

export type { AnswerMode, JudgmentRecord };
export { judgeSample };
