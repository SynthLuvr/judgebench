import { chmod, readFile, writeFile } from "node:fs/promises";

import { errorCodeOf } from "./errors.ts";

/** Header written when configure creates a fresh keys file. */
const NEW_FILE_HEADER = [
  "# judgebench API keys — written by `judgebench configure`.",
  "# Load with: judgebench --env-file <this file>",
];

/** Env var names accepted for storage: UPPER_SNAKE_CASE only. */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** One KEY=VALUE pair parsed from an env file. */
type EnvPair = {
  readonly key: string;
  readonly value: string;
};

/** A requested change; value null removes the key. */
type EnvUpdate = {
  readonly key: string;
  readonly value: string | null;
};

/** Parse one env-file line into a pair; null for blanks and comments.
 * Mirrors the loading rules of loadEnvFile so what configure writes is
 * exactly what the CLI later reads. */
const parseEnvLine = (rawLine: string): EnvPair | null => {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("#")) return null;
  const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
  const equals = withoutExport.indexOf("=");
  if (equals <= 0) return null;
  const key = withoutExport.slice(0, equals).trim();
  let value = withoutExport.slice(equals + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1);
  return { key, value };
};

const parseEnvText = (text: string): readonly EnvPair[] =>
  text
    .split("\n")
    .map(parseEnvLine)
    .filter((pair): pair is EnvPair => pair !== null);

/** Read an env-style file; null when it does not exist yet. */
const readEnvFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return null;
    throw error;
  }
};

const keyLinePattern = (key: string): RegExp =>
  new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`);

/**
 * Apply key updates to an env-style file, preserving every foreign line
 * and comment. Creates the file (mode 0600) when missing. Returns the
 * keys whose stored value actually changed.
 */
const updateEnvKeys = async (
  path: string,
  updates: readonly EnvUpdate[],
): Promise<readonly string[]> => {
  for (const update of updates)
    if (!ENV_KEY_PATTERN.test(update.key))
      throw new Error(
        `invalid key name ${JSON.stringify(update.key)}: must be UPPER_SNAKE_CASE`,
      );

  const previous = await readEnvFile(path);
  const created = previous === null;
  const lines = (previous ?? NEW_FILE_HEADER.join("\n")).split("\n");
  const changed: string[] = [];
  for (const { key, value } of updates) {
    const index = lines.findIndex((line) => keyLinePattern(key).test(line));
    if (value === null) {
      // loadEnvFile's first occurrence wins, so remove only the first.
      if (index !== -1) {
        lines.splice(index, 1);
        changed.push(key);
      }
      continue;
    }
    const replacement = `${key}=${value}`;
    if (index !== -1) {
      if (lines[index] === replacement) continue;
      lines[index] = replacement;
    } else lines.push(replacement);
    changed.push(key);
  }
  const text = lines.join("\n");
  await writeFile(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  // writeFile's mode is umask-masked; chmod pins 0600 for new key files.
  if (created) await chmod(path, 0o600);
  return changed;
};

/** Goose-style masking for display: keep the edges, hide the middle. */
const maskSecret = (value: string): string =>
  value.length <= 8 ? "••••••" : `${value.slice(0, 4)}••••${value.slice(-4)}`;

export type { EnvPair, EnvUpdate };
export {
  ENV_KEY_PATTERN,
  maskSecret,
  parseEnvText,
  readEnvFile,
  updateEnvKeys,
};
