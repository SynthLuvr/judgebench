import { defineCommand } from "./command";

// TODO Phase 0: full offline pipeline through the MSW interceptor module —
// no network, no keys, CI-safe.
const smokeCommand = defineCommand(
  "smoke",
  "full offline pipeline through MSW — no network, no keys",
);

export { smokeCommand };
