import type { Command } from "commander";

import {
  buildProvider,
  type Message,
  OpenAIProvider,
  type ProviderRequestOptions,
} from "system-one-adapter";

import { isNamedProviderKey, NAMED_ENDPOINTS } from "../core/config.ts";
import {
  claudeCodeModel,
  isJudgmentRecord,
  type JudgmentRecord,
  opencodeGoFetch,
  type StoredAttempt,
} from "../core/judge.ts";
import { readJsonl } from "../io/jsonl.ts";
import { type JudgeManifest, readManifest } from "../io/manifest.ts";
import { emitJson, log } from "../io/output.ts";

import {
  CommandError,
  DEFAULT_RUNS_DIR,
  EXIT_CONFIG,
  EXIT_PROVIDER,
  flagString,
  normalizeRunId,
} from "./context.ts";

/** The API-key env var an endpoint judge needs. The fallbacks cover
 * manifests written before `apiKeyEnv` was recorded: presets fall back
 * to their endpoint table, custom judges to OpenAI's default. */
const apiKeyEnvOf = (judgeMeta: JudgeManifest): string | undefined => {
  if (judgeMeta.provider === "custom")
    return judgeMeta.apiKeyEnv ?? "OPENAI_API_KEY";
  if (!isNamedProviderKey(judgeMeta.provider)) return undefined;
  return judgeMeta.apiKeyEnv ?? NAMED_ENDPOINTS[judgeMeta.provider].apiKeyEnv;
};

/** The provider a stored attempt was originally sent through, rebuilt
 * from the manifest so replay hits the same endpoint, key, and headers. */
const providerOf = (judgeMeta: JudgeManifest | undefined) => {
  if (judgeMeta === undefined) return buildProvider("openai", "gpt-4o-mini");
  if (judgeMeta.provider === "claude-code")
    return claudeCodeModel(judgeMeta.model);
  // Laya answers the adapter's typed questions directly; stored attempts
  // carry only messages, so a laya judgment has nothing re-sendable.
  if (judgeMeta.provider === "laya")
    throw new CommandError(
      `judge ${judgeMeta.id} runs on the local laya engine, which answers typed questions directly — its stored attempts carry no typed questions and cannot be replayed; re-run the judgment instead (laya is deterministic, so a re-run reproduces it)`,
      EXIT_CONFIG,
    );
  const apiKeyEnv = apiKeyEnvOf(judgeMeta);
  // openai/anthropic let the SDK resolve its own default credentials.
  if (apiKeyEnv === undefined)
    return buildProvider(
      judgeMeta.provider === "anthropic" ? "anthropic" : "openai",
      judgeMeta.model,
    );
  if (process.env[apiKeyEnv] === undefined)
    throw new CommandError(
      `${apiKeyEnv} is not set — export it or pass --env-file to replay judge ${judgeMeta.id}`,
      EXIT_CONFIG,
    );
  return new OpenAIProvider(judgeMeta.model, {
    baseUrl: judgeMeta.baseUrl,
    apiKey: process.env[apiKeyEnv],
    fetch:
      judgeMeta.provider === "opencode-go"
        ? opencodeGoFetch(judgeMeta.id)
        : undefined,
  });
};

/** A judgment whose stored attempt survived — the only replayable kind. */
type ReplayRecord = JudgmentRecord & { readonly llm_attempt: StoredAttempt };

/** True when a stored message fits the adapter's `Message` role union. */
const isAdapterMessage = (
  message: StoredAttempt["messages"][number],
): message is Message =>
  message.role === "system" ||
  message.role === "user" ||
  message.role === "assistant";

/** Stored messages narrowed into adapter form; rejects malformed entries. */
const adapterMessagesOf = (messages: StoredAttempt["messages"]): Message[] =>
  messages.map((message) => {
    if (!isAdapterMessage(message))
      throw new CommandError("stored llm_attempt has a malformed message", 2);
    return message;
  });

/** True when stored request parameters fit `ProviderRequestOptions`. */
const isRequestOptions = (value: unknown): value is ProviderRequestOptions =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "schema" in value &&
  typeof value.schema === "object" &&
  value.schema !== null &&
  !Array.isArray(value.schema) &&
  "structured" in value &&
  typeof value.structured === "boolean";

/** Stored request parameters; a config error when the shape drifted. */
const requestOptionsOf = (value: unknown): ProviderRequestOptions => {
  if (!isRequestOptions(value))
    throw new CommandError(
      "stored llm_attempt has malformed model_request_parameters",
      2,
    );
  return value;
};

const registerReplay = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("replay")
    .description("re-send one stored llm_attempt through its provider")
    .requiredOption("--run <runId>", "run directory under runs/")
    .requiredOption("--sample <sid>", "sample id to replay")
    .option("--judge <id>", "narrow to one judge")
    .option("--order <order>", "narrow to one order (AB or BA)")
    .action(async (flags: Record<string, unknown>) => {
      const runId = normalizeRunId(String(flags.run));
      const runDir = `${DEFAULT_RUNS_DIR}/${runId}`;
      const records = await readJsonl(
        `${runDir}/judgments.jsonl`,
        isJudgmentRecord,
      );
      const candidates = records.filter(
        (record): record is ReplayRecord =>
          record.sample_id === flags.sample &&
          (flags.judge === undefined || record.judge === flags.judge) &&
          (flags.order === undefined || record.order === flags.order) &&
          record.llm_attempt !== null,
      );
      const record = candidates[0];
      if (record === undefined)
        throw new CommandError(
          `no replayable judgment for sample ${flagString(flags.sample)} in ${runDir}`,
          2,
        );
      const manifest = await readManifest(runDir);
      const judgeMeta = manifest.judges.find(
        (judge) => judge.id === record.judge,
      );
      const attempt = record.llm_attempt;
      const provider = providerOf(judgeMeta);
      const messages = adapterMessagesOf(attempt.messages);
      const options = requestOptionsOf(attempt.model_request_parameters);
      log(
        `replaying ${record.judge} ${record.order} attempt (${record.model})`,
      );
      try {
        const result = await provider.request(messages, options);
        emitJson({
          run_id: runId,
          sample_id: record.sample_id,
          judge: record.judge,
          order: record.order,
          model: record.model,
          text: result.text,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandError(
          `replay request failed: ${message}`,
          EXIT_PROVIDER,
        );
      }
      await provider.close();
      program.setOptionValue("_exitCode", 0);
    });
  addGlobals(command);
};

export { registerReplay };
