type DatasetId = "mtbench" | "arena" | "canaries";

type HumanLabel = "A" | "B" | "tie";

type Sample = {
  readonly id: string;
  readonly prompt: string;
  readonly response_a: string;
  readonly response_b: string;
  readonly human_label: HumanLabel;
  readonly model_a?: string;
  readonly model_b?: string;
};

// TODO Phase 0: load + schema-validate data/<name>.jsonl into Sample[],
// honoring --limit.
const loadDataset = async (
  _dataset: DatasetId,
  _limit?: number,
): Promise<Sample[]> => [];

export type { DatasetId, HumanLabel, Sample };
export { loadDataset };
