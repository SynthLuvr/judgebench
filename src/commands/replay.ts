import { defineCommand } from "./command";

// TODO Phase 3: re-send one stored llm_attempt through its provider
// for debugging.
const replayCommand = defineCommand(
  "replay",
  "re-send one stored llm_attempt through its provider",
);

export { replayCommand };
