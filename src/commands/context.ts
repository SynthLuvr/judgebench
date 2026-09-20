import { readFile } from "node:fs/promises";

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
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
    const equals = withoutExport.indexOf("=");
    if (equals <= 0) continue;
    const key = withoutExport.slice(0, equals).trim();
    let value = withoutExport.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
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
  flagString,
  loadEnvFile,
  providerEnvKey,
};
