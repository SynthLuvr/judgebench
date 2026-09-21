import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CellSpec, resolveConfig } from "../core/config.ts";
import type { Sample } from "../core/dataset.ts";
import { buildClient, judgeSample } from "../core/judge.ts";

// Offline coverage of the claude-code judge path (the adapter's own suite
// stubs the CLI the same way): a fake `claude` on PATH prints one
// print-mode result payload per call and records its invocation, so the
// transport runs without the real CLI, a login, or network access.

const SAMPLE: Sample = {
  id: "cli-1",
  prompt: "What is the capital of France?",
  response_a: "The capital of France is Paris.",
  response_b: "Paris is the capital of France, a city of light.",
  human_label: "A",
  model_a: "model-a",
  model_b: "model-b",
};

const CELL: CellSpec = {
  answerMode: "probabilities",
  structuredOutputs: true,
  labels: ["A", "B", "tie"],
  rubric: null,
};

const JUDGE = {
  id: "claude-code/claude-haiku-4-5",
  provider: "claude-code" as const,
  model: "claude-haiku-4-5",
};

/** One print-mode result payload, as the CLI would print it. */
const RESULT_PAYLOAD = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "end_turn",
  result: JSON.stringify({
    answers: { verdict: { A: 0.7, B: 0.2, tie: 0.1 } },
  }),
  usage: {
    input_tokens: 3,
    output_tokens: 4,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
  },
});

/** Print the payload, recording args, stdin, and key env vars. */
const STUB_SCRIPT = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$@" > "$STUB_DIR/args"',
  'cat > "$STUB_DIR/stdin"',
  'printenv MAX_THINKING_TOKENS > "$STUB_DIR/thinking"',
  'printenv ANTHROPIC_API_KEY > "$STUB_DIR/key"',
  "printf '%s' \"$STUB_RESULT\"",
  "",
].join("\n");

let stubDir: string;
let previous: { PATH?: string; ANTHROPIC_API_KEY?: string };

beforeAll(async () => {
  previous = {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  stubDir = await mkdtemp(join(tmpdir(), "judgebench-claude-"));
  const stubPath = join(stubDir, "claude");
  await writeFile(stubPath, STUB_SCRIPT, "utf8");
  await chmod(stubPath, 0o755);
  process.env.STUB_DIR = stubDir;
  process.env.STUB_RESULT = RESULT_PAYLOAD;
  // Loaded keys must not leak into the CLI's environment.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.PATH = `${stubDir}:${process.env.PATH}`;
});

afterAll(async () => {
  process.env.PATH = previous.PATH;
  if (previous.ANTHROPIC_API_KEY === undefined)
    delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previous.ANTHROPIC_API_KEY;
  delete process.env.STUB_DIR;
  delete process.env.STUB_RESULT;
  await rm(stubDir, { recursive: true, force: true });
});

/** The stub's recorded argv, one entry per line (empty arg = empty line). */
const stubArgs = async (): Promise<string[]> =>
  (await readFile(join(stubDir, "args"), "utf8")).split("\n").slice(0, -1);

describe("claude-code judges", () => {
  it("judge a sample through a stubbed claude CLI", async () => {
    const resolved = await resolveConfig(
      "src/tests/fixtures/minimal.config.json",
      {},
    );
    const client = buildClient(JUDGE, CELL, resolved);
    const record = await judgeSample(
      client,
      SAMPLE,
      "AB",
      CELL,
      JUDGE.id,
      "hash1",
      null,
    );
    await client.close();

    expect(record.error).toBeNull();
    expect(record.raw_label).toBe("A");
    expect(record.probs).toEqual([0.7, 0.2, 0.1]);
    // Input tokens include the CLI's cache-write and cache-read tokens.
    expect(record.usage?.input_tokens_total).toBe(303);
    expect(record.usage?.output_tokens_total).toBe(4);
    expect(record.model).toBe("claude-haiku-4-5");

    const args = await stubArgs();
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--no-session-persistence");
    // Structured mode passes the answer schema to the CLI.
    expect(args).toContain("--json-schema");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5");

    const stdin = await readFile(join(stubDir, "stdin"), "utf8");
    expect(stdin).toContain(SAMPLE.prompt);
    expect(stdin).toContain(SAMPLE.response_a);

    // The CLI environment: thinking off, no inherited API key.
    expect(await readFile(join(stubDir, "thinking"), "utf8")).toBe("0\n");
    expect(await readFile(join(stubDir, "key"), "utf8")).toBe("");
  });

  it("record CLI failures as error records instead of throwing", async () => {
    const resolved = await resolveConfig(
      "src/tests/fixtures/minimal.config.json",
      {},
    );
    const withoutStub = await mkdtemp(join(tmpdir(), "judgebench-empty-"));
    const pathSaved = process.env.PATH;
    process.env.PATH = withoutStub; // `claude` no longer resolvable
    try {
      const client = buildClient(JUDGE, CELL, resolved);
      const record = await judgeSample(
        client,
        SAMPLE,
        "AB",
        CELL,
        JUDGE.id,
        "hash1",
        null,
      );
      await client.close();
      expect(record.raw_label).toBeNull();
      expect(record.error).toMatch(/Claude Code CLI/);
      expect(record.error_type).toBe("APIConnectionError");
      expect(record.usage).toBeNull();
    } finally {
      process.env.PATH = pathSaved;
      await rm(withoutStub, { recursive: true, force: true });
    }
  });
});
