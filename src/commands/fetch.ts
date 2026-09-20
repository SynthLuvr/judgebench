import { defineCommand } from "./command";

// TODO Phase 0: download + normalize a dataset into data/<name>.jsonl,
// with a licensing check at fetch time.
const fetchCommand = defineCommand(
  "fetch",
  "download + normalize a dataset into data/<name>.jsonl",
);

export { fetchCommand };
