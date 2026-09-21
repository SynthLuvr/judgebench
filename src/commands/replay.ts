import type { Command } from "commander";

import {
  buildProvider,
  type Message,
  OpenAIProvider,
  type ProviderRequestOptions,
} from "system-one-adapter";

import type { JudgmentRecord, StoredAttempt } from "../core/judge.ts";
import { readJsonl } from "../io/jsonl.ts";
import { type JudgeManifest, readManifest } from "../io/manifest.ts";
import { emitJson, log } from "../io/output.ts";

import {
  CommandError,
  DEFAULT_RUNS_DIR,
  EXIT_PROVIDER,
  flagString,
  normalizeRunId,
} from "./context.ts";

/** The provider a stored attempt was originally sent through. */
const providerOf = (judgeMeta: JudgeManifest | undefined) =>
  judgeMeta?.provider === "custom"
    ? new OpenAIProvider(judgeMeta.model, {
        baseUrl: judgeMeta.baseUrl,
        apiKey:
          judgeMeta.baseUrl === undefined
            ? process.env.OPENAI_API_KEY
            : undefined,
      })
    : buildProvider(
        judgeMeta?.provider === "anthropic" ? "anthropic" : "openai",
        judgeMeta?.model ?? "gpt-4o-mini",
      );

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
      const records = (await readJsonl(
        `${runDir}/judgments.jsonl`,
      )) as JudgmentRecord[];
      const candidates = records.filter(
        (record) =>
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
      const attempt = record.llm_attempt as StoredAttempt;
      const provider = providerOf(judgeMeta);
      const messages = attempt.messages.map((message) => ({
        ...message,
      })) as Message[];
      const options =
        attempt.model_request_parameters as ProviderRequestOptions;
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
