import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AnalysisResult, computeMetrics } from "../analysis/metrics";
import { renderCsv, renderMarkdown } from "../commands/report";
import { executeRun } from "../commands/run";
import type { ResolvedConfig } from "../core/config";
import { loadPricing } from "../core/cost";
import {
  type DatasetId,
  generateCanaries,
  loadDataset,
  type Sample,
  writeDataset,
} from "../core/dataset";
import type { JudgmentRecord } from "../core/judge";
import { readJsonl } from "../io/jsonl";
import { completedKeys, type Manifest } from "../io/manifest";

import { startJudgebenchMsw } from "./msw";

process.env.OPENAI_API_KEY ??= "test-key";

const msw = startJudgebenchMsw();

let workDir: string;
let runsDir: string;
let dataDir: string;

/** Analyze a finished run's records against its dataset (test-side helper). */
const analyzeRun = async (
  runId: string,
  records: readonly JudgmentRecord[],
  manifest: Manifest,
  dataDir: string,
  bootstrapReps: number,
  seed: number,
): Promise<AnalysisResult> => {
  let samples: readonly Sample[] = [];
  try {
    samples = await loadDataset(dataDir, manifest.dataset.name as DatasetId);
  } catch {
    // dataset unavailable — model joins disabled, metrics still computed
  }
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  return computeMetrics(
    records,
    byId,
    [runId],
    manifest.dataset.name,
    manifest.adapter_version,
    {
      bootstrapReps,
      seed,
      selfPreferenceFilter: false,
      now: new Date(),
    },
    await loadPricing(),
  );
};

const RESOLVED: ResolvedConfig = {
  dataset: "canaries",
  judges: [
    { id: "openai/gpt-4o-mini", provider: "openai", model: "gpt-4o-mini" },
    {
      id: "custom/endpoint-model",
      provider: "custom",
      model: "endpoint-model",
      baseUrl: "https://api.example.test/v1",
    },
  ],
  cells: [
    {
      answerMode: "probabilities",
      structuredOutputs: true,
      labels: ["A", "B", "tie"],
      rubric: null,
    },
    {
      answerMode: "discrete",
      structuredOutputs: false,
      labels: ["A", "B"],
      rubric: null,
    },
  ],
  swap: "both",
  normalizeProbabilities: true,
  maxCorrectiveRetries: 1,
  concurrency: 4,
  limit: 6,
  maxCostUsd: null,
  seed: 1234,
};

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "judgebench-pipeline-"));
  runsDir = join(workDir, "runs");
  dataDir = join(workDir, "data");
  await writeDataset(
    dataDir,
    "canaries",
    generateCanaries(0xca4a5eed).slice(0, 6),
  );
});

afterAll(async () => {
  msw.close();
  if (workDir !== undefined)
    await rm(workDir, { recursive: true, force: true });
});

describe("offline pipeline", () => {
  it("runs the full matrix, resumes, analyzes, and reports", async () => {
    process.env.OPENAI_API_KEY ??= "test-key";
    const samples = generateCanaries(0xca4a5eed).slice(0, 6);
    const datasetText = `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`;
    const outcome = await executeRun({
      resolved: RESOLVED,
      runsDir,
      dataDir,
      globals: {
        configPath: "unused",
        envFile: undefined,
        json: false,
        verbose: false,
      },
      resumeRunId: undefined,
      samples,
      datasetText,
    });
    const expectedRecords = 6 * 2 * 2 * 2; // samples × judges × cells × orders
    expect(outcome.exitCode).toBe(0);
    expect(outcome.records).toHaveLength(expectedRecords);
    expect(outcome.records.every((record) => record.error === null)).toBe(true);
    // Every second-order record learned the pair's consistency.
    const secondOrders = outcome.records.filter(
      (record) => record.swap_consistent !== null,
    );
    expect(secondOrders.length).toBeGreaterThan(0);
    expect(
      secondOrders.every(
        (record) => typeof record.swap_consistent === "boolean",
      ),
    ).toBe(true);

    const analysis = await analyzeRun(
      outcome.runId,
      outcome.records,
      outcome.manifest,
      dataDir,
      100,
      7,
    );
    expect(analysis.groups).toHaveLength(4); // 2 judges × 2 cells
    expect(analysis.canaries).not.toBeNull();
    expect(analysis.canaries?.n).toBe(6);
    const markdown = renderMarkdown(analysis);
    expect(markdown).toContain("# judgebench report");
    expect(markdown).toContain("## Hypotheses");
    expect(renderCsv(analysis)).toContain("judge,answer_mode,structured");

    // Resume: a second execution adds nothing.
    const again = await executeRun({
      resolved: RESOLVED,
      runsDir,
      dataDir,
      globals: {
        configPath: "unused",
        envFile: undefined,
        json: false,
        verbose: false,
      },
      resumeRunId: outcome.runId,
      samples,
      datasetText,
    });
    expect(again.records).toHaveLength(expectedRecords);

    // And the stored JSONL yields the same completed-key index.
    const stored = (await readJsonl(
      join(runsDir, outcome.runId, "judgments.jsonl"),
    )) as Parameters<typeof completedKeys>[0];
    expect(completedKeys(stored).size).toBe(expectedRecords);
  });

  it("aborts with exit code 4 when the cost guard trips", async () => {
    const samples = generateCanaries(0xca4a5eed).slice(0, 4);
    const outcome = await executeRun({
      resolved: {
        ...RESOLVED,
        judges: RESOLVED.judges.slice(0, 1),
        cells: RESOLVED.cells.slice(0, 1),
        maxCostUsd: 0.000001,
      },
      runsDir,
      dataDir,
      globals: {
        configPath: "unused",
        envFile: undefined,
        json: false,
        verbose: false,
      },
      resumeRunId: undefined,
      samples,
    });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.aborted).toContain("cost guard");
    expect(outcome.records.length).toBeGreaterThan(0);
    expect(outcome.records.length).toBeLessThan(4 * 2);
  });
});
