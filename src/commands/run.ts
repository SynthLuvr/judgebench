import { defineCommand } from "./command";

// TODO Phase 1: execute judgments → runs/<id>/judgments.jsonl with
// checkpoint/resume, the swap protocol, and the --max-cost guard
// (exit code 4).
const runCommand = defineCommand(
  "run",
  "execute judgments → runs/<id>/judgments.jsonl",
);

export { runCommand };
