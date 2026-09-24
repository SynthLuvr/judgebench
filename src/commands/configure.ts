import { readFile, writeFile } from "node:fs/promises";

import type { Command } from "commander";
import { LAYA_MODELS } from "system-one-adapter";

import { ConfigError, parseJudge } from "../core/config.ts";
import { loadPricing } from "../core/cost.ts";
import {
  ENV_KEY_PATTERN,
  type EnvUpdate,
  maskSecret,
  parseEnvText,
  readEnvFile,
  updateEnvKeys,
} from "../core/envfile.ts";
import { errorCodeOf } from "../core/errors.ts";
import { emitJson, log } from "../io/output.ts";
import { type Prompts, ttyPrompts } from "../io/prompt.ts";
import {
  CommandError,
  EXIT_CONFIG,
  flagString,
  flagStrings,
} from "./context.ts";
import { globalsOf } from "./run.ts";

const DEFAULT_KEYS_FILE = ".env";

/** Sentinel choice values for the wizard menus. */
const DONE = "__done__";
const OTHER_MODEL = "__other__";
const CUSTOM_KEY = "__custom__";

/** API keys judgebench's built-in providers read from the environment. */
const KNOWN_KEYS = [
  {
    env: "OPENAI_API_KEY",
    label: "OpenAI",
    hint: "api.openai.com — openai/* judges",
  },
  {
    env: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    hint: "api.anthropic.com — anthropic/* judges",
  },
  { env: "ZAI_API_KEY", label: "Z.ai", hint: "api.z.ai — zai/* judges" },
  {
    env: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    hint: "api.deepseek.com — deepseek/* judges",
  },
  {
    env: "OPENCODE_API_KEY",
    label: "OpenCode Go",
    hint: "opencode.ai — opencode-go/* judges",
  },
] as const;

const KNOWN_ENVS = new Set<string>(KNOWN_KEYS.map(({ env }) => env));

/** Providers offered by the wizard, mirroring the config schema. */
const PROVIDERS = [
  {
    name: "openai",
    label: "OpenAI",
    hint: "Responses API — needs OPENAI_API_KEY",
  },
  {
    name: "anthropic",
    label: "Anthropic",
    hint: "Messages API — needs ANTHROPIC_API_KEY",
  },
  { name: "zai", label: "Z.ai GLM", hint: "needs ZAI_API_KEY" },
  { name: "deepseek", label: "DeepSeek", hint: "needs DEEPSEEK_API_KEY" },
  {
    name: "opencode-go",
    label: "OpenCode Go",
    hint: "subscription endpoint — needs OPENCODE_API_KEY",
  },
  {
    name: "claude-code",
    label: "Claude Code CLI",
    hint: "local `claude` login — no API key",
  },
  {
    name: "laya",
    label: "laya (local)",
    hint: "local ONNX engine — no API key",
  },
  {
    name: "custom",
    label: "Custom OpenAI-compatible",
    hint: "any baseUrl + apiKeyEnv",
  },
] as const;

type ConfigDoc = Record<string, unknown>;

type WizardPaths = {
  readonly configPath: string;
  readonly keysFile: string;
};

type KeyState = "file" | "env-only" | "missing";

type KeyStatus = {
  readonly env: string;
  readonly state: KeyState;
  readonly masked: string | null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A missing file reads as `{}` (fresh start); a broken file errors
 * rather than being silently overwritten. */
const readConfigDoc = async (path: string): Promise<ConfigDoc> => {
  let text: string | null;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return {};
    throw new CommandError(
      `cannot read config file ${path}: ${errorMessage(error)}`,
      EXIT_CONFIG,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `config file ${path} is not valid JSON — fix or remove it first: ${errorMessage(error)}`,
    );
  }
  if (!isJsonObject(parsed))
    throw new ConfigError(`config file ${path} must contain a JSON object`);
  return parsed;
};

/** A config file is a JSON object; its values stay untyped here. */
const isJsonObject = (value: unknown): value is ConfigDoc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Display id for a stored judge entry; never throws on odd entries. */
const judgeIdOf = (entry: string | ConfigDoc): string => {
  try {
    return parseJudge(entry).id;
  } catch {
    return JSON.stringify(entry);
  }
};

const judgesOf = (doc: ConfigDoc): readonly (string | ConfigDoc)[] =>
  Array.isArray(doc.judges) ? doc.judges.filter(isJudgeEntry) : [];

/** A stored judges entry is a CLI string or a judge object. */
const isJudgeEntry = (value: unknown): value is string | ConfigDoc =>
  typeof value === "string" ||
  (typeof value === "object" && value !== null && !Array.isArray(value));

/** Write the judges list back, preserving every other config key; a
 * fresh config gets the default dataset. */
const writeJudges = async (
  configPath: string,
  judges: readonly (string | ConfigDoc)[],
): Promise<ConfigDoc> => {
  const doc = await readConfigDoc(configPath);
  if (doc.dataset === undefined) doc.dataset = "canaries";
  doc.judges = [...judges];
  await writeFile(configPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return doc;
};

const readStoredKeys = async (path: string): Promise<Map<string, string>> => {
  const text = await readEnvFile(path);
  const pairs = text === null ? [] : parseEnvText(text);
  return new Map(pairs.map((pair) => [pair.key, pair.value]));
};

const keyStatus = (env: string, stored: Map<string, string>): KeyStatus => {
  const value = stored.get(env);
  if (value !== undefined)
    return { env, state: "file", masked: maskSecret(value) };
  const fromProcess = process.env[env];
  if (fromProcess !== undefined && fromProcess !== "")
    return { env, state: "env-only", masked: maskSecret(fromProcess) };
  return { env, state: "missing", masked: null };
};

const describeStatus = (status: KeyStatus): string =>
  status.state === "file"
    ? `stored (${status.masked})`
    : status.state === "env-only"
      ? "set in environment, not stored"
      : "missing";

/** Stored keys outside KNOWN_KEYS — custom judge keys. */
const customKeyNames = (stored: Map<string, string>): readonly string[] =>
  [...stored.keys()].filter((env) => !KNOWN_ENVS.has(env));

const keyStatuses = (stored: Map<string, string>): readonly KeyStatus[] => [
  ...KNOWN_KEYS.map(({ env }) => keyStatus(env, stored)),
  ...customKeyNames(stored).map((env) => keyStatus(env, stored)),
];

/** Known models for a provider: pricing table ids, or the adapter's
 * laya model list. */
const modelSuggestions = async (
  provider: string,
): Promise<readonly string[]> => {
  if (provider === "laya") return LAYA_MODELS;
  const pricing = await loadPricing();
  const prefix = `${provider}/`;
  return Object.keys(pricing.models)
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length));
};

const promptModel = async (
  prompts: Prompts,
  provider: string,
): Promise<string> => {
  const suggestions = await modelSuggestions(provider);
  if (suggestions.length === 0)
    return prompts.ask(`Model name for ${provider}`);
  const choice = await prompts.choose(`Model for ${provider}`, [
    ...suggestions.map((model) => ({ value: model, label: model })),
    { value: OTHER_MODEL, label: "Other…", hint: "type any model name" },
  ]);
  if (choice === OTHER_MODEL) return prompts.ask(`Model name for ${provider}`);
  return choice;
};

/** Provider → model → entry, validated by the same parseJudge the run
 * pipeline uses; re-asks until the entry is accepted. */
const promptJudgeEntry = async (
  prompts: Prompts,
): Promise<string | ConfigDoc> => {
  for (;;) {
    const provider = await prompts.choose(
      "Which provider should judge?",
      PROVIDERS.map((info) => ({
        value: info.name,
        label: info.label,
        hint: info.hint,
      })),
    );
    let entry: string | ConfigDoc;
    if (provider === "custom") {
      const model = await prompts.ask("Model name");
      const baseUrl = await prompts.ask(
        "Base URL (OpenAI-compatible, empty = SDK default)",
        { optional: true },
      );
      const apiKeyEnv = await prompts.ask("API key env var", {
        default: "OPENAI_API_KEY",
      });
      entry =
        baseUrl === "" ? { model, apiKeyEnv } : { model, baseUrl, apiKeyEnv };
    } else entry = `${provider}/${await promptModel(prompts, provider)}`;
    try {
      parseJudge(entry);
      return entry;
    } catch (error) {
      log(`judge rejected, try again: ${errorMessage(error)}`);
    }
  }
};

const configureModel = async (
  prompts: Prompts,
  configPath: string,
): Promise<void> => {
  const entry = await promptJudgeEntry(prompts);
  const id = judgeIdOf(entry);
  const existing = judgesOf(await readConfigDoc(configPath));
  if (existing.length === 0) {
    await writeJudges(configPath, [entry]);
    log(`config ${configPath}: judges set to [${id}]`);
    return;
  }
  const mode = await prompts.choose(
    `Current judges: ${existing.map(judgeIdOf).join(", ")}`,
    [
      { value: "add", label: `Add ${id} to the list` },
      { value: "replace", label: `Replace the list with ${id}` },
    ],
  );
  const judges = mode === "add" ? [...existing, entry] : [entry];
  await writeJudges(configPath, judges);
  log(`config ${configPath}: judges → ${judges.map(judgeIdOf).join(", ")}`);
};

/** Goose-style key entry: a value already in the environment can be
 * persisted to the file, stored values are only updated on demand, and
 * empty input cancels. */
const promptKeyValue = async (
  prompts: Prompts,
  env: string,
  stored: Map<string, string>,
): Promise<string | null> => {
  const saved = stored.get(env);
  const fromProcess = process.env[env];
  if (
    fromProcess !== undefined &&
    fromProcess !== "" &&
    fromProcess !== saved
  ) {
    log(`${env} is set via environment variable`);
    if (await prompts.confirm(`Save the environment value for ${env}?`))
      return fromProcess;
    return null;
  }
  if (saved !== undefined) {
    log(`${env} is already stored (${maskSecret(saved)})`);
    if (!(await prompts.confirm(`Update ${env}?`, false))) return null;
    const next = await prompts.secret(`New value for ${env} (empty cancels)`);
    return next === "" ? null : next;
  }
  const value = await prompts.secret(`Value for ${env} (empty cancels)`);
  return value === "" ? null : value;
};

const configureKeys = async (
  prompts: Prompts,
  keysFile: string,
): Promise<void> => {
  for (;;) {
    const stored = await readStoredKeys(keysFile);
    const known = KNOWN_KEYS.map((info) => ({
      info,
      status: keyStatus(info.env, stored),
    }));
    const choice = await prompts.choose("Which API key?", [
      ...known.map(({ info, status }) => ({
        value: info.env,
        label: `${info.label} — ${info.env}`,
        hint: `${describeStatus(status)} · ${info.hint}`,
      })),
      ...customKeyNames(stored).map((env) => ({
        value: env,
        label: env,
        hint: "custom key already stored in the file",
      })),
      {
        value: CUSTOM_KEY,
        label: "Another env var…",
        hint: "custom judge keys",
      },
      { value: DONE, label: "Done with keys" },
    ]);
    let env: string;
    if (choice === DONE) return;
    if (choice === CUSTOM_KEY) {
      env = await prompts.ask("Env var name (e.g. XAI_API_KEY)");
      if (!ENV_KEY_PATTERN.test(env)) {
        log(`${env} is not a valid env var name (UPPER_SNAKE_CASE)`);
        continue;
      }
    } else env = choice;
    const value = await promptKeyValue(prompts, env, stored);
    if (value === null) continue;
    await updateEnvKeys(keysFile, [{ key: env, value }]);
    log(`keys ${keysFile}: saved ${env} (${maskSecret(value)})`);
  }
};

const review = async (paths: WizardPaths): Promise<void> => {
  const doc = await readConfigDoc(paths.configPath);
  const judges = judgesOf(doc);
  const list = judges.map(judgeIdOf).join(", ");
  const dataset = typeof doc.dataset === "string" ? doc.dataset : "(unset)";
  log(
    `config ${paths.configPath}: dataset ${dataset}, judges ${list === "" ? "(none)" : list}`,
  );
  const stored = await readStoredKeys(paths.keysFile);
  for (const status of keyStatuses(stored))
    log(`key ${status.env}: ${describeStatus(status)}`);
};

/** Machine-readable counterpart of `review` for `--json`. */
const summaryOf = async (paths: WizardPaths): Promise<unknown> => {
  const doc = await readConfigDoc(paths.configPath);
  const stored = await readStoredKeys(paths.keysFile);
  return {
    config_path: paths.configPath,
    dataset: doc.dataset ?? null,
    judges: judgesOf(doc).map(judgeIdOf),
    keys_file: paths.keysFile,
    keys: keyStatuses(stored).map((status) => ({
      env: status.env,
      state: status.state,
      value: status.masked,
    })),
  };
};

/** The interactive wizard: a model / keys / review menu until done.
 * Exported so tests can drive it with scripted prompts. */
const runWizard = async (
  prompts: Prompts,
  paths: WizardPaths,
): Promise<void> => {
  log(
    "judgebench configure — models go to the config file, API keys to the keys file",
  );
  for (;;) {
    const action = await prompts.choose("What would you like to configure?", [
      {
        value: "model",
        label: "Judge model(s)",
        hint: "provider + model, written to the config file",
      },
      {
        value: "keys",
        label: "API keys",
        hint: "written to the keys file (created with mode 0600)",
      },
      { value: "review", label: "Review current configuration" },
      { value: DONE, label: "Done" },
    ]);
    if (action === DONE) break;
    if (action === "model") await configureModel(prompts, paths.configPath);
    else if (action === "keys") await configureKeys(prompts, paths.keysFile);
    else await review(paths);
  }
  log(`next: judgebench --env-file ${paths.keysFile} validate`);
};

/** `--set-key KEY=VALUE` stores as-is; `--set-key KEY` prompts for the
 * value, which requires a TTY. */
const collectKeyUpdates = async (
  specs: readonly string[],
  prompts: () => Prompts,
): Promise<readonly EnvUpdate[]> => {
  const updates: EnvUpdate[] = [];
  for (const spec of specs) {
    const equals = spec.indexOf("=");
    const key = equals === -1 ? spec : spec.slice(0, equals);
    if (equals !== -1) {
      updates.push({ key, value: spec.slice(equals + 1) });
      continue;
    }
    if (process.stdin.isTTY !== true)
      throw new CommandError(
        `--set-key ${key} needs a value: --set-key ${key}=value (or run interactively)`,
        EXIT_CONFIG,
      );
    const value = await prompts().secret(`Value for ${key} (empty cancels)`);
    if (value !== "") updates.push({ key, value });
  }
  return updates;
};

/** Non-interactive mode: apply --judge / --set-key / --unset-key. */
const runFlagMode = async (
  flags: Record<string, unknown>,
  paths: WizardPaths,
  prompts: () => Prompts,
): Promise<void> => {
  const judgesFlag = flagStrings(flags.judge);
  if (judgesFlag !== undefined) {
    for (const judge of judgesFlag) parseJudge(judge);
    await writeJudges(paths.configPath, judgesFlag);
    log(
      `config ${paths.configPath}: judges → ${judgesFlag.map(judgeIdOf).join(", ")}`,
    );
  }

  const setKeys = flagStrings(flags.setKey) ?? [];
  const updates = await collectKeyUpdates(setKeys, prompts);
  if (updates.length > 0) {
    const changed = await updateEnvKeys(paths.keysFile, updates);
    for (const key of changed) log(`keys ${paths.keysFile}: saved ${key}`);
  }

  const unsetKeys = flagStrings(flags.unsetKey) ?? [];
  if (unsetKeys.length > 0) {
    const changed = await updateEnvKeys(
      paths.keysFile,
      unsetKeys.map((key) => ({ key, value: null })),
    );
    for (const key of changed) log(`keys ${paths.keysFile}: removed ${key}`);
  }
};

const hasFlagWork = (flags: Record<string, unknown>): boolean =>
  flags.judge !== undefined ||
  flags.setKey !== undefined ||
  flags.unsetKey !== undefined ||
  flags.list === true;

const registerConfigure = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("configure")
    .description(
      "set the judge model(s) and API keys — interactive wizard, or flags",
    )
    .option("--judge <provider/model...>", "set the config file judge list")
    .option(
      "--set-key <KEY=VALUE...>",
      "store an API key in the keys file (KEY alone prompts for the value)",
    )
    .option("--unset-key <KEY...>", "remove a key from the keys file")
    .option("--keys-file <path>", "key file to read/write", DEFAULT_KEYS_FILE)
    .option("--list", "show config and key status")
    .action(async (flags: Record<string, unknown>, _command: Command) => {
      const globals = globalsOf(_command);
      const paths = {
        configPath: globals.configPath,
        keysFile: flagString(flags.keysFile),
      };
      const flagMode = hasFlagWork(flags);
      if (!flagMode && process.stdin.isTTY !== true)
        throw new CommandError(
          "configure needs an interactive terminal — use --judge, --set-key, --unset-key, or --list for non-interactive use",
          EXIT_CONFIG,
        );
      // The readline session owns stdin; create it on demand and always
      // release it so the process can exit.
      const state: { session: Prompts | null } = { session: null };
      const prompts = (): Prompts => (state.session ??= ttyPrompts());
      try {
        if (flagMode) await runFlagMode(flags, paths, prompts);
        else await runWizard(prompts(), paths);
        if (globals.json) emitJson(await summaryOf(paths));
        else if (flags.list === true) await review(paths);
        log(`load keys with: judgebench --env-file ${paths.keysFile} …`);
        program.setOptionValue("_exitCode", 0);
      } finally {
        state.session?.close();
      }
    });
  addGlobals(command);
};

export { registerConfigure, runWizard };
