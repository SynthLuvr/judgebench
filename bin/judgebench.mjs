#!/usr/bin/env node
// Launcher for the judgebench CLI (the package.json "bin" target):
// spawns the current node on the TypeScript entry point, which node
// strips natively (node >= 24, per `engines`) — no shell, no tsx
// dependency at runtime, and no `.CMD` shim, per the launcher pattern
// of ts-canon's bin/ts-canon.mjs. Spawning rather than importing keeps
// src/cli.ts's direct-invocation guard authoritative: in the child,
// argv[1] is src/cli.ts itself. judgebench is private and runs from a
// checkout or a `link:` install, whose sources resolve outside
// node_modules, so — unlike the published ts-canon — no type-strip
// hook is needed.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const result = spawnSync(
  process.execPath,
  [join(packageRoot, "src", "cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`judgebench: failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
