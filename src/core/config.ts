import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { type } from "arktype";

/** Canonical label universe; every label set is a subset in this order. */
const ALL_LABELS = ["A", "B", "tie"] as const;

type HumanLabel = (typeof ALL_LABELS)[number];

type AnswerMode = "probabilities" | "discrete";

type SwapMode = "both" | "single";

type RubricMode = "default" | null;

/**
 * Named OpenAI-compatible endpoints usable as `provider/model` judge
 * strings. Z.ai and DeepSeek serve their own APIs; OpenCode Go fronts
 * open models (including DeepSeek) behind an OpenCode Zen subscription.
 */
const NAMED_ENDPOINTS = {
  zai: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  "opencode-go": {
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
  },
} as const;

type NamedProviderKey = keyof typeof NAMED_ENDPOINTS;

/** Local laya checkpoints (github.com/NandhaKishorM/laya) a judge can run. */
const LAYA_MODELS = [
  "router",
  "english",
  "multilingual",
  "typed-decisions",
] as const;

type LayaModel = (typeof LAYA_MODELS)[number];

type ProviderKind = "openai" | "anthropic" | "custom" | NamedProviderKey;

/** One judge: a built-in provider/model pair, a named endpoint, the local
 * laya engine, or a fully custom OpenAI-compatible endpoint. */
type JudgeSpec = {
  readonly id: string;
  readonly provider: ProviderKind | "laya";
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
  "provider?": type.enumerated("zai", "deepseek", "opencode-go", "laya"),
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

const JUDGE_PATTERN =
  /^(openai|anthropic|zai|deepseek|opencode-go|laya)\/([^/]+)$/;

const PROVIDER_KEYS = [
  "openai",
  "anthropic",
  ...Object.keys(NAMED_ENDPOINTS),
  "laya",
] as const;

const isNamedProviderKey = (value: string): value is NamedProviderKey =>
  Object.hasOwn(NAMED_ENDPOINTS, value);

const isLayaModel = (value: string): value is LayaModel =>
  (LAYA_MODELS as readonly string[]).includes(value);

/** Parse a judge entry (CLI string or config object) into a spec. */
const parseJudge = (entry: string | object): JudgeSpec => {
  if (typeof entry === "string") {
    const match = JUDGE_PATTERN.exec(entry);
    if (match === null)
      throw new ConfigError(
        `invalid judge ${JSON.stringify(entry)}: must look like provider/model with provider one of ${PROVIDER_KEYS.join(", ")}`,
      );
    const provider = match[1];
    const model = match[2];
    if (provider === "laya") {
      if (!isLayaModel(model))
        throw new ConfigError(
          `invalid judge ${JSON.stringify(entry)}: laya model must be one of ${LAYA_MODELS.join(", ")}`,
        );
      return { id: entry, provider: "laya", model };
    }
    if (isNamedProviderKey(provider)) {
      const endpoint = NAMED_ENDPOINTS[provider];
      return {
        id: entry,
        provider,
        model,
        baseUrl: endpoint.baseUrl,
        apiKeyEnv: endpoint.apiKeyEnv,
      };
    }
    return {
      id: entry,
      provider: provider as "openai" | "anthropic",
      model,
    };
  }
  const parsed = JudgeObjectSchema(entry);
  if (parsed instanceof type.errors)
    throw new ConfigError(`invalid judge entry: ${parsed.summary}`);
  const preset = parsed.provider;
  if (preset === "laya") {
    if (!isLayaModel(parsed.model))
      throw new ConfigError(
        `invalid laya judge model ${JSON.stringify(parsed.model)}: must be one of ${LAYA_MODELS.join(", ")}`,
      );
    if (parsed.baseUrl !== undefined || parsed.apiKeyEnv !== undefined)
      throw new ConfigError(
        "laya judges run locally and take no baseUrl/apiKeyEnv",
      );
    const id = parsed.label ?? `laya/${parsed.model}`;
    return { id, provider: "laya", model: parsed.model };
  }
  if (preset !== undefined && isNamedProviderKey(preset)) {
    const endpoint = NAMED_ENDPOINTS[preset];
    const id = parsed.label ?? `${preset}/${parsed.model}`;
    return {
      id,
      provider: preset,
      model: parsed.model,
      baseUrl: parsed.baseUrl ?? endpoint.baseUrl,
      apiKeyEnv: parsed.apiKeyEnv ?? endpoint.apiKeyEnv,
    };
  }
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

export type {
  CellSpec,
  HumanLabel,
  JudgeSpec,
  LayaModel,
  NamedProviderKey,
  ProviderKind,
  ResolvedConfig,
};
export {
  ConfigError,
  configHash,
  LAYA_MODELS,
  NAMED_ENDPOINTS,
  parseJudge,
  resolveConfig,
};
