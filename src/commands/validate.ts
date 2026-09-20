import { defineCommand } from "./command";

// TODO Phase 0: static checks — dataset schema, config resolution,
// API keys present.
const validateCommand = defineCommand(
  "validate",
  "static checks: dataset schema, config resolution, API keys",
);

export { validateCommand };
