import { rm } from "node:fs/promises";

import { afterAll, describe, expect, it, vi } from "vitest";

// Side-effect import: executes the bin entry's module top level (the
// direct-invocation guard is false under vitest) so cli.ts stays in
// coverage scope.
import "../cli.ts";
import { buildProgram, COMMAND_NAMES, main } from "../commands/index.ts";
import { generateCanaries, writeDataset } from "../core/dataset.ts";

import { startJudgebenchMsw } from "./msw.ts";

describe("cli router", () => {
  it("registers the eight documented commands in order", () => {
    const program = buildProgram();
    const names = program.commands
      .filter((command) => command.name() !== "help")
      .map((command) => command.name());
    expect(names).toEqual([...COMMAND_NAMES]);
  });

  it("exits 2 on an unknown command", async () => {
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["bogus"]);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it("exits 2 on an unknown option", async () => {
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["run", "--nope"]);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it("exits 0 for --help", async () => {
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["--help"]);
    err.mockRestore();
    expect(code).toBe(0);
  });

  it("exits 2 for fetch without --dataset", async () => {
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["fetch"]);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it("exits 2 for an unknown dataset", async () => {
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["fetch", "--dataset", "nope"]);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it("exits 2 when analyze finds no runs", async () => {
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["analyze", "--runs", "does-not-exist"]);
    err.mockRestore();
    expect(code).toBe(2);
  });
});

describe("output discipline", () => {
  const msw = startJudgebenchMsw();

  afterAll(() => msw.close());

  it("keeps --json stdout machine-readable with progress on stderr", async () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    // Seed the shared scratch dataset so `run` has samples to judge.
    await writeDataset(
      "data",
      "canaries",
      generateCanaries(0xca4a5eed).slice(0, 2),
    );
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        outChunks.push(String(chunk));
        return true;
      });
    const err = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errChunks.push(args.map((part) => String(part)).join(" "));
      });
    const code = await main([
      "run",
      "--config",
      "src/tests/fixtures/minimal.config.json",
      "--limit",
      "2",
      "--json",
    ]);
    out.mockRestore();
    err.mockRestore();
    expect(code).toBe(0);
    const stdout = outChunks.join("");
    const parsed = JSON.parse(stdout) as { run_id: string; records: number };
    expect(parsed.records).toBe(4); // 1 judge × 1 cell × 2 orders × 2 samples
    expect(errChunks.join("")).toContain(parsed.run_id);
    await rm(`runs/${parsed.run_id}`, { recursive: true, force: true });
    await rm("data/canaries.jsonl", { force: true });
  });
});
