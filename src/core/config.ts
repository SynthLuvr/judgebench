import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { type } from "arktype";

/** Canonical label universe; every label set is a subset in this order. */
const ALL_LABELS = ["A", "B", "tie"] as const;

type HumanLabel = (typeof ALL_LABELS)[number];

type AnswerMode = "probabilities" | "discrete";

type SwapMode = "both" | "single";

type RubricMode = "default" | null;

/** One judge: a built-in provider/model pair or a custom endpoint. */
type JudgeSpec = {
  readonly id: string;
  readonly provider: "openai" | "anthropic" | "custom";
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
};

/** One experiment cell: the axis combination a config hash is built from. */
type CellSpec = {
  readonly answerMode: AnswerMode;
  readonly structuredOutputs: boolean;
  readonly labels: readonly HumanLabel[];
  readonly rubric: RubricMode;
};

type ResolvedConfig = {
  readonly dataset: "mtbench" | "arena" | "canaries";
  readonly judges: readonly JudgeSpec[];
  readonly cells: readonly CellSpec[];
  readonly swap: SwapMode;
  readonly normalizeProbabilities: boolean;
  readonly maxCorrectiveRetries: number;
  readonly concurrency: number;
  readonly limit: number | null;
  readonly maxCostUsd: number | null;
  readonly seed: number;
};

const canonicallyOrdered = (labels: readonly string[]): boolean =>
  labels.every((label) => (ALL_LABELS as readonly string[]).includes(label)) &&
  labels.join(",") ===
    ALL_LABELS.filter((label) => labels.includes(label)).join(",");

const LabelsSchema = type("string[]")
  .atLeastLength(2)
  .narrow((labels) => canonicallyOrdered(labels));

const RubricSchema = type("'default' | null");

const JudgeObjectSchema = type({
  model: "string > 0",
  "baseUrl?": "string > 0",
  "apiKeyEnv?": "string > 0",
  "label?": "string > 0",
}).onUndeclaredKey("reject");

const CellSchema = type({
  "answerMode?": type.enumerated("probabilities", "discrete"),
  "structuredOutputs?": "boolean",
  "labels?": LabelsSchema,
  "rubric?": RubricSchema,
}).onUndeclaredKey("reject");

const ConfigFileSchema = type({
  dataset: type.enumerated("mtbench", "arena", "canaries"),
  judges: type("string | object").array().atLeastLength(1),
  "answerMode?": type.enumerated("probabilities", "discrete"),
  "structuredOutputs?": "boolean",
  "labels?": LabelsSchema,
  "swap?": type.enumerated("both", "single"),
  "normalizeProbabilities?": "boolean",
  "maxCorrectiveRetries?": "number.integer >= 0",
  "concurrency?": "number.integer >= 1",
  "limit?": "number.integer >= 1 | null",
  "maxCostUsd?": "number > 0 | null",
  "rubric?": RubricSchema,
  "cells?": CellSchema.array().atLeastLength(1),
  "seed?": "number.integer >= 0",
}).onUndeclaredKey("reject");

type ConfigFile = typeof ConfigFileSchema.infer;

const DEFAULTS = {
  answerMode: "probabilities",
  structuredOutputs: true,
  labels: ["A", "B", "tie"],
  swap: "both",
  normalizeProbabilities: true,
  maxCorrectiveRetries: 1,
  concurrency: 8,
} as const;

const JUDGE_PATTERN = /^(openai|anthropic)\/([^/]+)$/;

/** Parse a judge entry (CLI string or config object) into a spec. */
const parseJudge = (entry: string | object): JudgeSpec => {
  if (typeof entry === "string") {
    const match = JUDGE_PATTERN.exec(entry);
    if (match === null)
      throw new ConfigError(
        `invalid judge ${JSON.stringify(entry)}: must look like provider/model, e.g. openai/gpt-4o-mini`,
      );
    const provider = match[1] as "openai" | "anthropic";
    return { id: entry, provider, model: match[2] };
  }
  const parsed = JudgeObjectSchema(entry);
  if (parsed instanceof type.errors)
    throw new ConfigError(`invalid judge entry: ${parsed.summary}`);
  const id = parsed.label ?? `custom/${parsed.model}`;
  return {
    id,
    provider: "custom",
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    apiKeyEnv: parsed.apiKeyEnv,
  };
};

/** Error thrown for unreadable or invalid configuration; maps to exit 2. */
class ConfigError extends Error {}

const loadConfigFile = async (path: string): Promise<ConfigFile> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `cannot read config file ${path}: ${errorMessage(error)}`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `config file ${path} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const parsed = ConfigFileSchema(parsedJson);
  if (parsed instanceof type.errors)
    throw new ConfigError(`config file ${path} is invalid: ${parsed.summary}`);
  return parsed;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Explicit flag overrides applied on top of the config file. */
type FlagOverrides = {
  readonly dataset?: "mtbench" | "arena" | "canaries";
  readonly judges?: readonly string[];
  readonly answerMode?: AnswerMode;
  readonly structuredOutputs?: boolean;
  readonly labels?: readonly string[];
  readonly swap?: SwapMode;
  readonly concurrency?: number;
  readonly limit?: number;
  readonly maxCostUsd?: number | null;
  readonly rubric?: RubricMode;
  readonly maxCorrectiveRetries?: number;
  readonly normalizeProbabilities?: boolean;
};

/** Resolve flags > config file > defaults into one run configuration. */
const resolveConfig = async (
  configPath: string,
  overrides: FlagOverrides,
): Promise<ResolvedConfig> => {
  const file = await loadConfigFile(configPath);
  const judges = (overrides.judges ?? file.judges).map(parseJudge);
  const judgeIds = new Set<string>();
  for (const judge of judges) {
    if (judgeIds.has(judge.id))
      throw new ConfigError(`duplicate judge: ${judge.id}`);
    judgeIds.add(judge.id);
  }
  type RawCell = {
    answerMode?: CellSpec["answerMode"];
    structuredOutputs?: boolean;
    labels?: readonly string[];
    rubric?: CellSpec["rubric"];
  };
  const fileCells: readonly RawCell[] = file.cells ?? [{}];
  // Axis flags override every matrix cell (flag > config file > defaults).
  const cells: CellSpec[] = [];
  for (const raw of fileCells) {
    const labels =
      overrides.labels ?? raw.labels ?? file.labels ?? DEFAULTS.labels;
    const labelCheck = LabelsSchema([...labels]);
    if (labelCheck instanceof type.errors)
      throw new ConfigError(
        `invalid labels [${labels.join(", ")}]: ${labelCheck.summary}`,
      );
    const cell: CellSpec = {
      answerMode:
        overrides.answerMode ??
        raw.answerMode ??
        file.answerMode ??
        DEFAULTS.answerMode,
      structuredOutputs:
        overrides.structuredOutputs ??
        raw.structuredOutputs ??
        file.structuredOutputs ??
        DEFAULTS.structuredOutputs,
      labels: labels as readonly HumanLabel[],
      rubric:
        overrides.rubric !== undefined
          ? overrides.rubric
          : (raw.rubric ?? file.rubric ?? null),
    };
    const previous = cells.find(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(cell),
    );
    if (previous === undefined) cells.push(cell);
  }
  return {
    dataset: overrides.dataset ?? file.dataset,
    judges,
    cells,
    swap: overrides.swap ?? file.swap ?? DEFAULTS.swap,
    normalizeProbabilities:
      overrides.normalizeProbabilities ??
      file.normalizeProbabilities ??
      DEFAULTS.normalizeProbabilities,
    maxCorrectiveRetries:
      overrides.maxCorrectiveRetries ??
      file.maxCorrectiveRetries ??
      DEFAULTS.maxCorrectiveRetries,
    concurrency:
      overrides.concurrency ?? file.concurrency ?? DEFAULTS.concurrency,
    limit: overrides.limit ?? file.limit ?? null,
    maxCostUsd: overrides.maxCostUsd ?? file.maxCostUsd ?? null,
    seed: file.seed ?? 0x5eed_0001,
  };
};

/** Stable identifier for one judge × cell experiment configuration. */
const configHash = (
  judge: JudgeSpec,
  cell: CellSpec,
  config: ResolvedConfig,
): string => {
  const canonical = JSON.stringify({
    dataset: config.dataset,
    judge: { id: judge.id, model: judge.model, provider: judge.provider },
    cell,
    swap: config.swap,
    normalizeProbabilities: config.normalizeProbabilities,
    maxCorrectiveRetries: config.maxCorrectiveRetries,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
};

export type { CellSpec, HumanLabel, JudgeSpec, ResolvedConfig };
export { ConfigError, configHash, parseJudge, resolveConfig };
