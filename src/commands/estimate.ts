import { defineCommand } from "./command";

// TODO Phase 2: project run cost via a small live pilot (5 samples),
// not just a chars/4 heuristic.
const estimateCommand = defineCommand(
  "estimate",
  "project run cost via a small live pilot (5 samples)",
);

export { estimateCommand };
