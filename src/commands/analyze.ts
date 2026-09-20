import { defineCommand } from "./command";

// TODO Phase 1: metrics from judgment files → analysis.json
// (agreement + flips first, calibration + debiasing in Phase 2).
const analyzeCommand = defineCommand(
  "analyze",
  "compute metrics from judgment files → analysis.json",
);

export { analyzeCommand };
