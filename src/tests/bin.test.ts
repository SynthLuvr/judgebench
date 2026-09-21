import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(
  new URL("../../bin/judgebench.mjs", import.meta.url),
);

/** End-to-end: the bin launcher -> native type stripping -> the CLI. */
const runLauncher = (args: readonly string[]): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: "utf8" });

describe("bin/judgebench.mjs", () => {
  it("prints help on stderr and exits 0 with stdout clean", () => {
    const result = runLauncher(["--help"]);
    expect(result.status).toBe(0);
    // Help is program output, so it goes to stderr; stdout stays
    // pipeable for --json.
    expect(result.stdout).toBe("");
    expect(result.stderr ?? "").toContain("Usage: judgebench");
  }, 120_000);

  it("exits 2 for an unknown command", () => {
    const result = runLauncher(["bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr ?? "").toContain("bogus");
  }, 120_000);
});
