import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { type } from "arktype";

import type { ResolvedConfig } from "../core/config.ts";

type CellManifest = {
  readonly answerMode: string;
  readonly structuredOutputs: boolean;
  readonly labels: readonly string[];
  readonly rubric: string | null;
};

type JudgeManifest = {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
};

type Manifest = {
  readonly run_id: string;
  readonly created: string;
  readonly judgebench_version: string;
  readonly adapter_version: string;
  readonly dataset: {
    readonly name: string;
    readonly content_hash: string;
    readonly n_samples: number;
  };
  readonly judges: readonly JudgeManifest[];
  readonly cells: readonly CellManifest[];
  readonly swap: string;
  readonly normalizeProbabilities: boolean;
  readonly maxCorrectiveRetries: number;
  readonly concurrency: number;
  readonly seed: number;
  readonly limit: number | null;
  readonly max_cost_usd: number | null;
  readonly aborted?: string;
};

const PackageJsonSchema = type({ "version?": "string" });

const ManifestSchema = type({
  run_id: "string",
  created: "string",
  judgebench_version: "string",
  adapter_version: "string",
  dataset: {
    name: "string",
    content_hash: "string",
    n_samples: "number",
  },
  judges: type({
    id: "string",
    provider: "string",
    model: "string",
    "baseUrl?": "string",
  }).array(),
  cells: type({
    answerMode: "string",
    structuredOutputs: "boolean",
    labels: "string[]",
    rubric: "string | null",
  }).array(),
  swap: "string",
  normalizeProbabilities: "boolean",
  maxCorrectiveRetries: "number",
  concurrency: "number",
  seed: "number",
  limit: "number | null",
  max_cost_usd: "number | null",
  "aborted?": "string",
});

/** Runtime guard for a parsed manifest.json (file boundary). */
const isManifest = (value: unknown): value is Manifest =>
  !(ManifestSchema(value) instanceof type.errors);

const require_ = createRequire(import.meta.url);

/** Version field of a resolvable package's package.json, "unknown" on error. */
const packageVersion = (request: string): string => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(require_.resolve(`${request}/package.json`), "utf8"),
    );
    const validated = PackageJsonSchema(parsed);
    if (validated instanceof type.errors) return "unknown";
    return validated.version ?? "unknown";
  } catch {
    return "unknown";
  }
};

/** This package, resolved relative to dist/io rather than node_modules. */
const judgebenchVersion = (): string => packageVersion("../..");

const buildManifest = (
  runId: string,
  config: ResolvedConfig,
  dataset: { name: string; contentHash: string; nSamples: number },
): Manifest => ({
  run_id: runId,
  created: new Date().toISOString(),
  judgebench_version: judgebenchVersion(),
  adapter_version: packageVersion("system-one-adapter"),
  dataset: {
    name: dataset.name,
    content_hash: dataset.contentHash,
    n_samples: dataset.nSamples,
  },
  judges: config.judges.map((judge) => ({
    id: judge.id,
    provider: judge.provider,
    model: judge.model,
    ...(judge.baseUrl === undefined ? {} : { baseUrl: judge.baseUrl }),
  })),
  cells: config.cells.map((cell) => ({
    answerMode: cell.answerMode,
    structuredOutputs: cell.structuredOutputs,
    labels: [...cell.labels],
    rubric: cell.rubric,
  })),
  swap: config.swap,
  normalizeProbabilities: config.normalizeProbabilities,
  maxCorrectiveRetries: config.maxCorrectiveRetries,
  concurrency: config.concurrency,
  seed: config.seed,
  limit: config.limit,
  max_cost_usd: config.maxCostUsd,
});

const manifestPath = (runDir: string): string => join(runDir, "manifest.json");

const writeManifest = async (
  runDir: string,
  manifest: Manifest,
): Promise<void> => {
  await mkdir(runDir, { recursive: true });
  await writeFile(
    manifestPath(runDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
};

const readManifest = async (runDir: string): Promise<Manifest> => {
  const text = await readFile(manifestPath(runDir), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isManifest(parsed))
    throw new Error(`${manifestPath(runDir)}: invalid manifest.json`);
  return parsed;
};

/** Keys of already-completed judgments, for `--resume` checkpointing. */
const completedKeys = (
  records: readonly {
    sample_id: string;
    judge: string;
    config_hash: string;
    order: string;
  }[],
): Set<string> => {
  const keys = new Set<string>();
  for (const record of records)
    keys.add(
      `${record.sample_id}|${record.judge}|${record.config_hash}|${record.order}`,
    );
  return keys;
};

export type { CellManifest, JudgeManifest, Manifest };
export {
  buildManifest,
  completedKeys,
  packageVersion,
  readManifest,
  writeManifest,
};
