import { defineCommand } from "./command";

// TODO Phase 2: render markdown/CSV tables + Pareto data from analysis.
const reportCommand = defineCommand(
  "report",
  "render markdown/CSV tables + Pareto data from analysis",
);

export { reportCommand };
