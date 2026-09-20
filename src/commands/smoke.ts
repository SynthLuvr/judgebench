import { mkdir, writeFile } from "node:fs/promises";
import type { Command } from "commander";

import type { ResolvedConfig } from "../core/config";
import { generateCanaries, writeDataset } from "../core/dataset";
import { type JudgmentRecord } from "../core/judge";
import { emitJson, log } from "../io/output";

import { startJudgebenchMsw } from "../tests/msw";
import { renderMarkdown } from "./report";
import { analyzeRun, executeRun, globalsOf } from "./run";

/** Full offline pipeline through MSW — no network, no keys, CI-safe. */
const registerSmoke = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("smoke")
    .description("full offline pipeline through MSW — no network, no keys")
    .option("--limit <n>", "canary sample count", (value) =>
      Number.parseInt(value, 10),
    )
    .action(async (flags: Record<string, unknown>, command: Command) => {
      const globals = globalsOf(command);
      const msw = startJudgebenchMsw();
      process.env.OPENAI_API_KEY ??= "smoke-test-key";
      process.env.ANTHROPIC_API_KEY ??= "smoke-test-key";
      const limit =
        flags.limit === undefined ? 12 : Math.max(2, flags.limit as number);
      try {
        const samples = generateCanaries(0xca4a5eed).slice(0, limit);
        const datasetText = `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`;
        const resolved: ResolvedConfig = {
          dataset: "canaries",
          judges: [
            {
              id: "openai/gpt-4o-mini",
              provider: "openai",
              model: "gpt-4o-mini",
            },
            {
              id: "anthropic/claude-haiku-4-5",
              provider: "anthropic",
              model: "claude-haiku-4-5",
            },
            {
              id: "custom/smoke-endpoint-model",
              provider: "custom",
              model: "smoke-endpoint-model",
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
          ],
          swap: "both",
          normalizeProbabilities: true,
          maxCorrectiveRetries: 1,
          concurrency: 4,
          limit,
          maxCostUsd: null,
          seed: 0x5eedc0de,
        };
        const outcome = await executeRun({
          resolved,
          runsDir: "runs",
          dataDir: "runs",
          globals,
          resumeRunId: undefined,
          samples,
          datasetText,
        });
        // Keep the dataset next to the run so analyze can join model fields.
        const runDataDir = `runs/${outcome.runId}/data`;
        await writeDataset(runDataDir, "canaries", samples);
        const analysis = await analyzeRun(
          outcome.runId,
          outcome.records,
          outcome.manifest,
          runDataDir,
          200,
          0x5eed_0001,
        );
        const report = renderMarkdown(analysis);
        await mkdir(`runs/${outcome.runId}`, { recursive: true });
        await writeFile(`runs/${outcome.runId}/REPORT.md`, report, "utf8");
        await writeFile(
          `runs/${outcome.runId}/analysis.json`,
          `${JSON.stringify(analysis, null, 2)}\n`,
          "utf8",
        );
        const errors = outcome.records.filter(
          (record: JudgmentRecord) => record.error !== null,
        ).length;
        if (globals.json)
          emitJson({
            run_id: outcome.runId,
            records: outcome.records.length,
            errors,
            spend_usd: outcome.spendUsd,
            canaries: analysis.canaries,
          });
        else {
          log(
            `smoke ok: ${outcome.records.length} judgments, ${errors} errors → runs/${outcome.runId}/`,
          );
          log(`report: runs/${outcome.runId}/REPORT.md`);
          if (analysis.canaries !== null)
            log(
              `injection followed ${analysis.canaries.injection_followed_rate.point.toFixed(3)}, robust ${analysis.canaries.robustness_rate.point.toFixed(3)}`,
            );
        }
        program.setOptionValue("_exitCode", outcome.exitCode);
      } finally {
        msw.close();
      }
    });
  addGlobals(command);
};

export { registerSmoke };
