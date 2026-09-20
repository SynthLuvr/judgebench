import "../analysis/bootstrap";
import "../analysis/calibration";
import "../analysis/metrics";
import { describe, expect, it } from "vitest";

import { projectCost } from "../core/cost";
import { loadDataset } from "../core/dataset";
import { judgeSample } from "../core/judge";
import { decideSwap } from "../core/swap";
import { appendJsonl, readJsonl } from "../io/jsonl";
import { writeManifest } from "../io/manifest";

// The three analysis imports above are side-effect imports: they keep the
// type-only analysis modules in coverage scope until Phase 2 gives them
// runtime exports.
describe("scaffold stubs", () => {
  it("dataset loader resolves empty until Phase 0", async () => {
    await expect(loadDataset("mtbench", 5)).resolves.toEqual([]);
  });

  it("judge resolves null until Phase 1", async () => {
    await expect(judgeSample()).resolves.toBeNull();
  });

  it("swap decision abstains until Phase 1", () => {
    expect(decideSwap(null, null)).toBeNull();
  });

  it("cost projection is null until Phase 1", () => {
    expect(projectCost(10)).toBeNull();
  });

  it("jsonl io resolves until Phase 1", async () => {
    await expect(
      appendJsonl("runs/x/judgments.jsonl", {}),
    ).resolves.toBeUndefined();
    await expect(readJsonl("runs/x/judgments.jsonl")).resolves.toEqual([]);
  });

  it("manifest writer resolves until Phase 1", async () => {
    await expect(
      writeManifest({
        run_id: "r",
        created: "2026-09-20T00:00:00Z",
        config_hash: "h",
        adapter_version: "0.3.0",
        dataset_hash: "d",
        judges: [],
      }),
    ).resolves.toBeUndefined();
  });
});
