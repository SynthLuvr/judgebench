import { readFile } from "node:fs/promises";

import { parseEnvText } from "../core/envfile.ts";

/** Options every command receives from the global CLI flags. */
type GlobalOptions = {
  readonly configPath: string;
  readonly envFile: string | undefined;
  readonly json: boolean;
  readonly verbose: boolean;
};

/** Exit codes: 0 ok · 2 config/validation · 3 provider/network · 4 cost cap. */
const EXIT_OK = 0;
const EXIT_CONFIG = 2;
const EXIT_PROVIDER = 3;
const EXIT_COST = 4;

const DEFAULT_CONFIG_PATH = "judgebench.config.json";
const DEFAULT_DATA_DIR = "data";
const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_REPORTS_DIR = "reports";

/** Error carrying the exit code a command should terminate with. */
class CommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Load KEY=VALUE pairs from an env file, without overriding variables that
 * are already set in the environment.
 */
const loadEnvFile = async (path: string): Promise<string[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new CommandError(
      `cannot read env file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CONFIG,
    );
  }
  const loaded: string[] = [];
  for (const { key, value } of parseEnvText(text))
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }

  return loaded;
};

/** Coerce a parsed CLI flag to a string without object stringification. */
const flagString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value) ?? "";
};

/** Optional string flag; undefined when unset, null when explicitly empty. */
const flagStringOption = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return flagString(value);
};

/** Variadic string flag (`--judge a b` → string[]); undefined when unset. */
const flagStrings = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value;
  throw new CommandError("expected one or more string values", EXIT_CONFIG);
};

/** Numeric flag (coerced by commander); undefined when unset. */
const flagNumber = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new CommandError("expected a number", EXIT_CONFIG);
};

/** Boolean flag; undefined when unset. */
const flagBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new CommandError("expected a boolean", EXIT_CONFIG);
};

/** Optional flag that is boolean when bare (`--rubric`) or takes a string
 * value (`--rubric default`). */
const flagBooleanOrString = (value: unknown): boolean | string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean" || typeof value === "string") return value;
  throw new CommandError("expected a boolean or a string", EXIT_CONFIG);
};

/** Accept `run-…`, `runs/run-…`, and trailing slashes as a run id. */
const normalizeRunId = (raw: string): string =>
  raw.replace(/^runs\//, "").replace(/\/$/, "");

/** Required API key env var per provider; null when none is needed.
 * Named presets carry their apiKeyEnv on the parsed judge instead. */
const providerEnvKey = (provider: string): string | null =>
  provider === "openai"
    ? "OPENAI_API_KEY"
    : provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : null;

export type { GlobalOptions };
export {
  CommandError,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DATA_DIR,
  DEFAULT_REPORTS_DIR,
  DEFAULT_RUNS_DIR,
  EXIT_CONFIG,
  EXIT_COST,
  EXIT_OK,
  EXIT_PROVIDER,
  flagBoolean,
  flagBooleanOrString,
  flagNumber,
  flagString,
  flagStringOption,
  flagStrings,
  loadEnvFile,
  normalizeRunId,
  providerEnvKey,
};
