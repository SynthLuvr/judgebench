import { describe, expect, it } from "vitest";

// Side-effect import: executes the bin entry's module top level (the
// direct-invocation guard is false under vitest) so cli.ts stays in
// coverage scope.
import "../cli";
import { commands, main } from "../commands/index";

describe("cli router", () => {
  it("registers the eight documented commands in order", () => {
    expect(commands.map((command) => command.name)).toEqual([
      "fetch",
      "validate",
      "estimate",
      "run",
      "analyze",
      "report",
      "smoke",
      "replay",
    ]);
  });

  it("exits 2 on an unknown command", async () => {
    await expect(main(["bogus"])).resolves.toBe(2);
  });

  it("exits 2 when no command is given", async () => {
    await expect(main([])).resolves.toBe(2);
  });

  it("routes to stubs that exit 2 until implemented", async () => {
    await expect(main(["smoke"])).resolves.toBe(2);
  });
});
