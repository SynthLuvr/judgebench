import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { main } from "../commands/index";

import { startJudgebenchMsw } from "./msw";

// End-to-end CLI coverage offline: every command drives the real pipeline
// through MSW-intercepted providers, using the repo's gitignored data/ and
// runs/ directories (created artifacts are removed afterwards).

const msw = startJudgebenchMsw();
const previousEnv = { ...process.env };
const createdFiles = ["data/canaries.jsonl", "data/canaries.meta.json"];

const listRunIds = async (): Promise<string[]> => {
  try {
    return (await readdir("runs"))
      .filter((entry) => entry.startsWith("run-"))
      .sort();
  } catch {
    return [];
  }
};

const latestRunId = async (): Promise<string> => {
  const entries = await listRunIds();
  const latest = entries[entries.length - 1];
  if (latest === undefined) throw new Error("no run directory");
  return latest;
};

/** Snapshot helper: returns a function resolving the id of a fresh run. */
const runCreatedAfter =
  (before: readonly string[]) => async (): Promise<string> => {
    const created = (await listRunIds()).filter(
      (entry) => !before.includes(entry),
    );
    if (created.length === 0) throw new Error("no new run directory");
    return created[created.length - 1];
  };

beforeAll(() => {
  process.env.OPENAI_API_KEY ??= "test-key";
  process.env.ANTHROPIC_API_KEY ??= "test-key";
});

afterAll(async () => {
  msw.close();
  process.env = previousEnv;
  for (const path of createdFiles) await rm(path, { force: true });
  await rm("reports", { recursive: true, force: true });
  for (const entry of await listRunIds())
    await rm(join("runs", entry), { recursive: true, force: true });
});

describe("cli end-to-end", () => {
  it("fetches canaries offline", async () => {
    const code = await main(["fetch", "--dataset", "canaries"]);
    expect(code).toBe(0);
    const lines = (await readFile("data/canaries.jsonl", "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);
    const meta = JSON.parse(
      await readFile("data/canaries.meta.json", "utf8"),
    ) as {
      license: string | null;
      source: string;
    };
    expect(meta.source).toContain("generated");
  });

  it("validates config, dataset, and keys", async () => {
    expect(await main(["validate", "--dataset", "canaries"])).toBe(0);
  });

  it("fails validation when the provider key is missing", async () => {
    const saved = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const code = await main(["validate", "--dataset", "canaries"]);
    process.env.OPENAI_API_KEY = saved.openai;
    process.env.ANTHROPIC_API_KEY = saved.anthropic;
    expect(code).toBe(2);
  });

  it("runs, analyzes, and reports through MSW", async () => {
    const fresh = runCreatedAfter(await listRunIds());
    expect(
      await main([
        "run",
        "--config",
        "src/tests/fixtures/minimal.config.json",
        "--limit",
        "4",
        "--json",
      ]),
    ).toBe(0);
    const runId = await fresh();
    const records = (await readFile(`runs/${runId}/judgments.jsonl`, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // Fixture config: 1 judge × 1 cell × 2 orders × 4 samples.
    expect(records).toHaveLength(8);
    const manifest = JSON.parse(
      await readFile(`runs/${runId}/manifest.json`, "utf8"),
    ) as {
      adapter_version: string;
      dataset: { name: string };
    };
    expect(manifest.adapter_version).toBe("0.3.0");
    expect(manifest.dataset.name).toBe("canaries");

    expect(await main(["analyze", "--runs", runId, "--json"])).toBe(0);
    const analysis = JSON.parse(
      await readFile(`runs/${runId}/analysis.json`, "utf8"),
    ) as {
      groups: { judge: string }[];
      canaries: { n: number } | null;
    };
    expect(analysis.groups).toHaveLength(1);
    expect(analysis.canaries?.n).toBe(4);

    expect(await main(["report", "--runs", runId])).toBe(0);
    const markdown = await readFile(`reports/REPORT-${runId}.md`, "utf8");
    expect(markdown).toContain("# judgebench report");
    expect(markdown).toContain("## Injection robustness");
    expect(await main(["report", "--runs", runId, "--format", "csv"])).toBe(0);
    expect(await readFile(`reports/REPORT-${runId}.csv`, "utf8")).toContain(
      "judge,answer_mode,structured",
    );
  });

  it("rejects runs without stored judgments", async () => {
    expect(await main(["analyze", "--runs", "missing-run"])).toBe(2);
  });

  it("analyzes the latest run by default", async () => {
    expect(await main(["analyze"])).toBe(0);
    const runId = await latestRunId();
    expect(await readFile(`runs/${runId}/analysis.json`, "utf8")).toContain(
      "agreement_debiased",
    );
  });

  it("replays a stored llm_attempt", async () => {
    const runId = await latestRunId();
    const judgments = (await readFile(`runs/${runId}/judgments.jsonl`, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sample_id: string; judge: string });
    const target = judgments.find((record) =>
      record.judge.startsWith("openai/"),
    );
    if (target === undefined) throw new Error("no openai record to replay");
    expect(
      await main([
        "replay",
        "--run",
        runId,
        "--sample",
        target.sample_id,
        "--judge",
        target.judge,
      ]),
    ).toBe(0);
  });

  it("replay errors for an unknown sample", async () => {
    const runId = await latestRunId();
    expect(await main(["replay", "--run", runId, "--sample", "nope"])).toBe(2);
  });

  it("estimates cost from a live pilot", async () => {
    expect(
      await main([
        "estimate",
        "--config",
        "src/tests/fixtures/minimal.config.json",
        "--limit",
        "3",
        "--json",
      ]),
    ).toBe(0);
  });

  it("loads --env-file before running", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "judgebench-env-"));
    const envPath = join(dir, "test.env");
    await writeFile(envPath, "# comment\nJUDGEBENCH_TEST_VAR=42\n", "utf8");
    const code = await main([
      "validate",
      "--dataset",
      "canaries",
      "--env-file",
      envPath,
    ]);
    await rm(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(process.env.JUDGEBENCH_TEST_VAR).toBe("42");
    delete process.env.JUDGEBENCH_TEST_VAR;
  });

  it("exits 2 for a missing env file", async () => {
    expect(await main(["validate", "--env-file", "/nonexistent.env"])).toBe(2);
  });

  it("exits 3 when every judgment fails at the provider", async () => {
    const { http, HttpResponse } = await import("msw");
    msw.server.use(
      http.post(
        "https://broken.example.test/v1/chat/completions",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    expect(
      await main([
        "run",
        "--config",
        "src/tests/fixtures/broken.config.json",
        "--json",
      ]),
    ).toBe(3);
    expect(
      await main([
        "estimate",
        "--config",
        "src/tests/fixtures/broken.config.json",
      ]),
    ).toBe(3);
    msw.server.resetHandlers();
  });

  it("runs and replays through a custom endpoint", async () => {
    const fresh = runCreatedAfter(await listRunIds());
    expect(
      await main([
        "run",
        "--config",
        "src/tests/fixtures/custom.config.json",
        "--limit",
        "2",
        "--json",
      ]),
    ).toBe(0);
    const runId = await fresh();
    const judgments = (await readFile(`runs/${runId}/judgments.jsonl`, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sample_id: string; judge: string });
    expect(
      judgments.every((record) => record.judge === "custom/test-endpoint"),
    ).toBe(true);
    expect(
      await main([
        "replay",
        "--run",
        runId,
        "--sample",
        judgments[0]?.sample_id ?? "",
        "--judge",
        "custom/test-endpoint",
      ]),
    ).toBe(0);
    const { http, HttpResponse } = await import("msw");
    msw.server.use(
      http.post(
        "https://api.example.test/v1/chat/completions",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    expect(
      await main([
        "replay",
        "--run",
        runId,
        "--sample",
        judgments[0]?.sample_id ?? "",
      ]),
    ).toBe(3);
    msw.server.resetHandlers();
  });

  it("runs axis-flag permutations and resumes", async () => {
    const fresh = runCreatedAfter(await listRunIds());
    expect(
      await main([
        "run",
        "--config",
        "src/tests/fixtures/minimal.config.json",
        "--limit",
        "3",
        "--answer-mode",
        "discrete",
        "--no-structured",
        "--labels",
        "A,B",
        "--swap",
        "single",
        "--rubric",
        "--concurrency",
        "2",
        "--max-cost",
        "5",
        "--json",
      ]),
    ).toBe(0);
    const runId = await fresh();
    const records = (await readFile(`runs/${runId}/judgments.jsonl`, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            probs: number[] | null;
            cell: { labels: string[] };
          },
      );
    // Single order per sample: 1 judge × 1 cell × 3 samples.
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.probs?.length === 2)).toBe(true);
    expect(
      records.every((record) => record.cell.labels.join("|") === "A|B"),
    ).toBe(true);
    // Resume completes nothing new.
    expect(
      await main([
        "run",
        "--config",
        "src/tests/fixtures/minimal.config.json",
        "--limit",
        "3",
        "--answer-mode",
        "discrete",
        "--no-structured",
        "--labels",
        "A,B",
        "--swap",
        "single",
        "--rubric",
        "--resume",
        runId,
        "--json",
      ]),
    ).toBe(0);
    const after = (await readFile(`runs/${runId}/judgments.jsonl`, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(after).toHaveLength(3);
  });

  it("exits 3 when the dataset upstream is down", async () => {
    const { http, HttpResponse } = await import("msw");
    msw.server.use(
      http.get("*/rows*", () => new HttpResponse(null, { status: 500 })),
    );
    expect(await main(["fetch", "--dataset", "mtbench"])).toBe(3);
    msw.server.resetHandlers();
  });

  it("flags a missing dataset file in validate", async () => {
    expect(await main(["validate", "--dataset", "mtbench"])).toBe(2);
  });

  it("validates custom-endpoint configs", async () => {
    expect(
      await main([
        "validate",
        "--config",
        "src/tests/fixtures/custom.config.json",
        "--dataset",
        "canaries",
      ]),
    ).toBe(0);
  });

  it("refuses to mix datasets across runs in analyze", async () => {
    const runId = await latestRunId();
    const { mkdir } = await import("node:fs/promises");
    await mkdir("runs/mix-fixture", { recursive: true });
    await writeFile(
      "runs/mix-fixture/manifest.json",
      JSON.stringify({ run_id: "mix-fixture", dataset: { name: "mtbench" } }),
      "utf8",
    );
    await writeFile(
      "runs/mix-fixture/judgments.jsonl",
      `${JSON.stringify({
        sample_id: "x",
        judge: "openai/gpt-4o-mini",
        config_hash: "h",
        order: "AB",
        raw_label: "A",
        probs: [0.9, 0.1],
        confidence: 0.8,
        swap_consistent: null,
        usage: null,
        retry_reasons: [],
        n_retries_malformed_structure: 0,
        model: "gpt-4o-mini",
        ts: "2026-01-01T00:00:00Z",
        cell: {
          answerMode: "probabilities",
          structuredOutputs: true,
          labels: ["A", "B"],
          rubric: null,
        },
        human_label: "A",
        error: null,
        error_type: null,
        llm_attempt: null,
      })}\n`,
      "utf8",
    );
    expect(await main(["analyze", "--runs", "mix-fixture", runId])).toBe(2);
    await rm("runs/mix-fixture", { recursive: true, force: true });
  });

  it("analyzes with filters, bootstrap caps, and self-preference slices", async () => {
    const runId = await latestRunId();
    expect(
      await main(["analyze", "--runs", runId, "--filter", "model_a==model_b"]),
    ).toBe(0);
    expect(await main(["analyze", "--runs", runId, "--bootstrap", "0"])).toBe(
      2,
    );
    expect(await main(["analyze", "--runs", runId, "--filter", "bogus"])).toBe(
      2,
    );
  });

  it("emits report json format and human estimate tables", async () => {
    const runId = await latestRunId();
    expect(await main(["report", "--runs", runId, "--format", "json"])).toBe(0);
    expect(
      await main([
        "estimate",
        "--config",
        "src/tests/fixtures/minimal.config.json",
      ]),
    ).toBe(0);
    expect(await main(["fetch", "--dataset", "canaries", "--limit", "5"])).toBe(
      0,
    );
  });

  it("runs the full pipeline across all three provider shapes", async () => {
    const fresh = runCreatedAfter(await listRunIds());
    expect(
      await main([
        "run",
        "--config",
        "src/tests/fixtures/providers.config.json",
        "--limit",
        "3",
        "--json",
      ]),
    ).toBe(0);
    const runId = await fresh();
    const judgments = (await readFile(`runs/${runId}/judgments.jsonl`, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { judge: string; error: string | null },
      );
    // 3 judges × 1 cell × 2 orders × 3 samples, all succeeding offline.
    expect(judgments).toHaveLength(18);
    expect(judgments.every((record) => record.error === null)).toBe(true);
    expect(new Set(judgments.map((record) => record.judge))).toEqual(
      new Set([
        "openai/gpt-4o-mini",
        "anthropic/claude-haiku-4-5",
        "custom/endpoint-model",
      ]),
    );
    expect(await main(["analyze", "--runs", runId, "--json"])).toBe(0);
    const analysis = JSON.parse(
      await readFile(`runs/${runId}/analysis.json`, "utf8"),
    ) as { groups: { judge: string }[] };
    expect(analysis.groups).toHaveLength(3);
    expect(await main(["report", "--runs", runId])).toBe(0);
    expect(await readFile(`reports/REPORT-${runId}.md`, "utf8")).toContain(
      "## Hypotheses",
    );
  });
});
