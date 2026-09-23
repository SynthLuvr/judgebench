import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { main } from "../commands/index.ts";

import { startJudgebenchMsw } from "./msw.ts";

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
  process.env.ZAI_API_KEY ??= "test-key";
  process.env.DEEPSEEK_API_KEY ??= "test-key";
  process.env.OPENCODE_API_KEY ??= "test-key";
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
    expect(manifest.adapter_version).toBe("0.4.0");
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

  it("runs the named provider presets end to end", async () => {
    expect(
      await main([
        "validate",
        "--config",
        "src/tests/fixtures/named.config.json",
        "--json",
      ]),
    ).toBe(0);
    const fresh = runCreatedAfter(await listRunIds());
    expect(
      await main([
        "run",
        "--config",
        "src/tests/fixtures/named.config.json",
        "--limit",
        "2",
        "--json",
      ]),
    ).toBe(0);
    const runId = await fresh();
    const judgments = (await readFile(`runs/${runId}/judgments.jsonl`, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            judge: string;
            error: string | null;
            sample_id: string;
          },
      );
    // 3 named judges × 1 cell × 2 orders × 2 samples, all offline.
    expect(judgments).toHaveLength(12);
    expect(judgments.every((record) => record.error === null)).toBe(true);
    const urls = msw.calls.map((call) => call.url);
    expect(urls).toContain("https://api.z.ai/api/paas/v4/chat/completions");
    expect(urls).toContain("https://api.deepseek.com/chat/completions");
    expect(urls).toContain("https://opencode.ai/zen/go/v1/chat/completions");
    const opencodeGo = msw.calls.find(
      (call) => call.url === "https://opencode.ai/zen/go/v1/chat/completions",
    );
    // OpenCode Go asks clients to self-identify (own UA + session header).
    expect(opencodeGo?.headers["user-agent"]).toBe("judgebench");
    expect(opencodeGo?.headers["x-opencode-session"]).toBe(
      "opencode-go/deepseek-v4.1-flash",
    );
    // The manifest records each preset's key var so replay resolves keys
    // exactly as the run did.
    const manifest = JSON.parse(
      await readFile(`runs/${runId}/manifest.json`, "utf8"),
    ) as { judges: { id: string; apiKeyEnv?: string }[] };
    expect(
      manifest.judges.find((judge) => judge.id === "zai/glm-4.7-flashx")
        ?.apiKeyEnv,
    ).toBe("ZAI_API_KEY");
    // Replay re-sends through the recorded endpoint (not api.openai.com),
    // with the preset's own key.
    const zai = judgments.find(
      (record) => record.judge === "zai/glm-4.7-flashx",
    );
    if (zai === undefined) throw new Error("no zai record to replay");
    const callsBefore = msw.calls.length;
    expect(
      await main([
        "replay",
        "--run",
        runId,
        "--sample",
        zai.sample_id,
        "--judge",
        zai.judge,
      ]),
    ).toBe(0);
    const replayCall = msw.calls
      .slice(callsBefore)
      .find((call) => call.url.endsWith("/chat/completions"));
    expect(replayCall?.url).toBe(
      "https://api.z.ai/api/paas/v4/chat/completions",
    );
    expect(replayCall?.headers["authorization"]).toBe("Bearer test-key");
    // opencode-go replay keeps the CLI's identifying headers.
    const go = judgments.find(
      (record) => record.judge === "opencode-go/deepseek-v4.1-flash",
    );
    if (go === undefined) throw new Error("no opencode-go record");
    const goBefore = msw.calls.length;
    expect(
      await main([
        "replay",
        "--run",
        runId,
        "--sample",
        go.sample_id,
        "--judge",
        go.judge,
      ]),
    ).toBe(0);
    const goCall = msw.calls
      .slice(goBefore)
      .find((call) => call.url.endsWith("/chat/completions"));
    expect(goCall?.headers["x-opencode-session"]).toBe(
      "opencode-go/deepseek-v4.1-flash",
    );
    // A missing preset key is a config error that names the variable.
    const savedKey = process.env.ZAI_API_KEY;
    delete process.env.ZAI_API_KEY;
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main([
      "replay",
      "--run",
      runId,
      "--sample",
      zai.sample_id,
      "--judge",
      zai.judge,
    ]);
    const errText = err.mock.calls.map((chunk) => String(chunk[0])).join("");
    err.mockRestore();
    process.env.ZAI_API_KEY = savedKey;
    expect(code).toBe(2);
    expect(errText).toContain("ZAI_API_KEY");
  });

  it("refuses to replay laya judgments with a clear error", async () => {
    // Synthetic laya run: one stored attempt, provider recorded as laya.
    const { mkdir } = await import("node:fs/promises");
    await mkdir("runs/laya-fixture", { recursive: true });
    await writeFile(
      "runs/laya-fixture/manifest.json",
      JSON.stringify({
        run_id: "laya-fixture",
        created: "2026-01-01T00:00:00Z",
        judgebench_version: "0.1.0",
        adapter_version: "0.4.0",
        dataset: { name: "canaries", content_hash: "x", n_samples: 1 },
        judges: [{ id: "laya/router", provider: "laya", model: "router" }],
        cells: [
          {
            answerMode: "probabilities",
            structuredOutputs: true,
            labels: ["A", "B", "tie"],
            rubric: null,
          },
        ],
        swap: "both",
        normalizeProbabilities: true,
        maxCorrectiveRetries: 1,
        concurrency: 2,
        seed: 1,
        limit: null,
        max_cost_usd: null,
      }),
      "utf8",
    );
    await writeFile(
      "runs/laya-fixture/judgments.jsonl",
      `${JSON.stringify({
        sample_id: "s1",
        judge: "laya/router",
        config_hash: "h",
        order: "AB",
        ts: "2026-01-01T00:00:00Z",
        cell: {
          answerMode: "probabilities",
          structuredOutputs: true,
          labels: ["A", "B", "tie"],
          rubric: null,
        },
        human_label: "A",
        raw_label: "A",
        probs: [0.5, 0.5, 0],
        confidence: null,
        swap_consistent: null,
        usage: null,
        retry_reasons: [],
        n_retries_malformed_structure: 0,
        model: "laya/router",
        error: null,
        error_type: null,
        llm_attempt: {
          messages: [{ role: "system", content: "judge" }],
          model_request_parameters: { schema: {}, structured: true },
          debug_info: { model_name: "laya/router", provider: "LayaProvider" },
        },
      })}\n`,
      "utf8",
    );
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main([
      "replay",
      "--run",
      "laya-fixture",
      "--sample",
      "s1",
    ]);
    const errText = err.mock.calls.map((chunk) => String(chunk[0])).join("");
    err.mockRestore();
    expect(code).toBe(2);
    // Names the judge, explains why, and stays actionable — no OpenAI
    // credentials red herring.
    expect(errText).toContain("laya/router");
    expect(errText).toContain("cannot be replayed");
    expect(errText).not.toContain("OPENAI_API_KEY");
    await rm("runs/laya-fixture", { recursive: true, force: true });
  });
});
