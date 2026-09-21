import { readFile } from "node:fs/promises";
import { type Command, Option } from "commander";

import { configHash, type ResolvedConfig, resolveConfig } from "../core/config";
import { contentHash, costOfUsage, loadPricing } from "../core/cost";
import { loadDataset, type Sample } from "../core/dataset";
import {
  buildClient,
  type JudgmentRecord,
  judgeSample,
  pricingId,
} from "../core/judge";
import { canonicalLabel, ordersFor, type SwapOrder } from "../core/swap";
import { appendJsonl, readJsonl } from "../io/jsonl";
import {
  buildManifest,
  completedKeys,
  type Manifest,
  readManifest,
  writeManifest,
} from "../io/manifest";
import {
  emitJson,
  log,
  progress,
  progressDone,
  verboseLog,
} from "../io/output";

import {
  CommandError,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DATA_DIR,
  DEFAULT_RUNS_DIR,
  EXIT_CONFIG,
  EXIT_COST,
  EXIT_OK,
  EXIT_PROVIDER,
  flagString,
  type GlobalOptions,
} from "./context";

type TaskUnit = {
  readonly sample: Sample;
  readonly judgeIndex: number;
  readonly cellIndex: number;
  readonly hash: string;
  readonly pendingOrders: readonly SwapOrder[];
};

type ExecuteRunOptions = {
  readonly resolved: ResolvedConfig;
  readonly runsDir: string;
  readonly dataDir: string;
  readonly globals: GlobalOptions;
  readonly resumeRunId: string | undefined;
  /** Preloaded samples (tests bypass data/); loaded from disk otherwise. */
  readonly samples?: readonly Sample[];
  /** Preloaded dataset text for hashing (tests). */
  readonly datasetText?: string;
};

type RunOutcome = {
  readonly exitCode: number;
  readonly runId: string;
  readonly records: readonly JudgmentRecord[];
  readonly manifest: Manifest;
  readonly spendUsd: number;
  readonly aborted: string | null;
};

const newRunId = (): string => {
  const now = new Date();
  const [date, clock] = [
    [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()],
    [now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()],
  ].map((parts) => parts.map((part) => String(part).padStart(2, "0")).join(""));
  const suffix = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `run-${date}-${clock}-${suffix}`;
};

const datasetTextOf = async (
  dataDir: string,
  dataset: ResolvedConfig["dataset"],
): Promise<string> => {
  try {
    return await readFile(`${dataDir}/${dataset}.jsonl`, "utf8");
  } catch {
    return "";
  }
};

/** Judge every pending task unit, appending records as they complete. */
const executeRun = async (options: ExecuteRunOptions): Promise<RunOutcome> => {
  const { resolved, globals } = options;
  const samples =
    options.samples ??
    (await loadDataset(options.dataDir, resolved.dataset, resolved.limit));
  if (samples.length === 0)
    throw new CommandError(
      `dataset ${resolved.dataset} has no samples — run \`judgebench fetch --dataset ${resolved.dataset}\` first`,
      EXIT_CONFIG,
    );

  const resume = options.resumeRunId;
  if (resume !== undefined && resume.includes("/"))
    throw new CommandError(
      `--resume takes a run id, not a path: ${resume}`,
      EXIT_CONFIG,
    );
  const runId = resume ?? newRunId();
  const runDir = `${options.runsDir}/${runId}`;
  const judgmentsPath = `${runDir}/judgments.jsonl`;

  const existing = (await readJsonl(judgmentsPath)) as JudgmentRecord[];
  const done = completedKeys(existing);

  let manifest: Manifest;
  if (resume === undefined || existing.length === 0) {
    const datasetText =
      options.datasetText ??
      (await datasetTextOf(options.dataDir, resolved.dataset));
    manifest = buildManifest(runId, resolved, {
      name: resolved.dataset,
      contentHash: contentHash(
        datasetText === "" ? JSON.stringify(samples) : datasetText,
      ),
      nSamples: samples.length,
    });
    await writeManifest(runDir, manifest);
  } else {
    manifest = await readManifest(runDir);
    if (manifest.dataset.name !== resolved.dataset)
      log(
        `warning: resuming run ${runId} with dataset ${resolved.dataset} but manifest recorded ${manifest.dataset.name}`,
      );
  }

  // Task units: one sample × judge × cell, with orders sequential inside.
  const units: TaskUnit[] = [];
  for (const [judgeIndex, judge] of resolved.judges.entries())
    for (const [cellIndex, cell] of resolved.cells.entries()) {
      const hash = configHash(judge, cell, resolved);
      for (const sample of samples) {
        const pendingOrders = ordersFor(
          sample.id,
          resolved.swap,
          resolved.seed,
        ).filter(
          (order) => !done.has(`${sample.id}|${judge.id}|${hash}|${order}`),
        );
        if (pendingOrders.length === 0) continue;
        units.push({ sample, judgeIndex, cellIndex, hash, pendingOrders });
      }
    }
  const totalJudgments =
    existing.length +
    units.reduce((sum, unit) => sum + unit.pendingOrders.length, 0);

  const clients = resolved.judges.map((judge) =>
    resolved.cells.map((cell) => buildClient(judge, cell, resolved)),
  );
  const pricing = await loadPricing();

  const freshRecords: JudgmentRecord[] = [];
  let completedJudgments = existing.length;
  let spendUsd = 0;
  let malformedRetries = 0;
  // Holder object so closure writes stay visible to control-flow analysis.
  const state: { aborted: string | null } = { aborted: null };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (state.aborted !== null) return;
      const index = cursor;
      cursor += 1;
      if (index >= units.length) return;
      const unit = units[index];
      if (unit === undefined) return;
      const judge = resolved.judges[unit.judgeIndex];
      const cell = resolved.cells[unit.cellIndex];
      const client = clients[unit.judgeIndex]?.[unit.cellIndex];
      if (judge === undefined || cell === undefined || client === undefined)
        return;
      let previousCanonical: ReturnType<typeof canonicalLabel> | null = null;
      for (const order of unit.pendingOrders) {
        const record = await judgeSample(
          client,
          unit.sample,
          order,
          cell,
          judge.id,
          unit.hash,
          previousCanonical,
        );
        await appendJsonl(judgmentsPath, record);
        freshRecords.push(record);
        completedJudgments += 1;
        if (record.usage !== null)
          spendUsd +=
            costOfUsage(pricing, pricingId(judge), record.usage)?.cost_usd ?? 0;
        malformedRetries += record.n_retries_malformed_structure;
        if (record.raw_label !== null)
          previousCanonical = canonicalLabel(record.raw_label, order);
        if (record.error !== null)
          verboseLog(
            globals.verbose,
            `judgment failed: ${unit.sample.id} ${order}: ${record.error}`,
          );
        if (resolved.maxCostUsd !== null && spendUsd > resolved.maxCostUsd) {
          state.aborted = `cost guard tripped at $${spendUsd.toFixed(4)} > $${resolved.maxCostUsd}`;
          return;
        }
      }
      progress(
        `${runId}: ${completedJudgments}/${totalJudgments} judgments, spend ~$${spendUsd.toFixed(4)}, malformed retries ${malformedRetries}`,
      );
    }
  };

  const workerCount = Math.max(1, Math.min(resolved.concurrency, units.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  progressDone();
  for (const row of clients) for (const client of row) await client.close();

  const records = [...existing, ...freshRecords];
  const allErrored =
    freshRecords.length > 0 &&
    freshRecords.every((record) => record.error !== null);
  let exitCode = EXIT_OK;
  const abortReason = state.aborted as string | null;
  if (abortReason !== null) {
    log(`${runId}: ${abortReason} — partial results kept in ${judgmentsPath}`);
    exitCode = EXIT_COST;
  } else if (allErrored) {
    log(`${runId}: every judgment failed — provider/network error`);
    exitCode = EXIT_PROVIDER;
  }
  return { exitCode, runId, records, manifest, spendUsd, aborted: abortReason };
};

const parseLabels = (raw: string): string[] =>
  raw.split(",").map((part) => part.trim());

const parseEnum = <T extends string>(
  value: string,
  allowed: readonly T[],
  flag: string,
): T => {
  if (!allowed.includes(value as T))
    throw new CommandError(
      `${flag} must be one of ${allowed.join(", ")}`,
      EXIT_CONFIG,
    );
  return value as T;
};

const registerRun = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("run")
    .description("execute judgments → runs/<id>/judgments.jsonl")
    .option("--judge <provider/model...>", "judges to run (repeatable)")
    .option("--answer-mode <mode>", "probabilities or discrete")
    .addOption(new Option("--structured", "structured outputs on"))
    .addOption(
      new Option("--no-structured", "structured outputs off").implies({
        structured: false,
      }),
    )
    .option("--labels <a,b[,tie]>", "comma-separated label set")
    .option("--swap <mode>", "both or single")
    .option("--rubric [mode]", "batch rubric sub-questions (mode: default)")
    .option("--concurrency <n>", "parallel judgments", (value) =>
      Number.parseInt(value, 10),
    )
    .option("--limit <n>", "judge only the first N samples", (value) =>
      Number.parseInt(value, 10),
    )
    .option("--max-cost <usd>", "abort when live spend exceeds this", (value) =>
      Number.parseFloat(value),
    )
    .option("--resume <runId>", "continue an existing run")
    .action(async (flags: Record<string, unknown>, _command: Command) => {
      const globals = globalsOf(_command);
      const answerMode =
        flags.answerMode === undefined
          ? undefined
          : parseEnum(
              flagString(flags.answerMode),
              ["probabilities", "discrete"],
              "--answer-mode",
            );
      const swap =
        flags.swap === undefined
          ? undefined
          : parseEnum(flagString(flags.swap), ["both", "single"], "--swap");
      const rubric = flags.rubric as boolean | string | undefined;
      const resolved = await resolveConfig(globals.configPath, {
        judges: flags.judge as string[] | undefined,
        answerMode,
        structuredOutputs: flags.structured as boolean | undefined,
        labels:
          flags.labels === undefined
            ? undefined
            : parseLabels(flagString(flags.labels)),
        swap,
        concurrency: flags.concurrency as number | undefined,
        limit: flags.limit as number | undefined,
        maxCostUsd: flags.maxCost as number | undefined,
        rubric:
          rubric === undefined
            ? undefined
            : rubric === true
              ? "default"
              : parseEnum(flagString(rubric), ["default"] as const, "--rubric"),
      });
      const outcome = await executeRun({
        resolved,
        runsDir: DEFAULT_RUNS_DIR,
        dataDir: DEFAULT_DATA_DIR,
        globals,
        resumeRunId: flags.resume as string | undefined,
      });
      const errors = outcome.records.filter(
        (record) => record.error !== null,
      ).length;
      if (globals.json)
        emitJson({
          run_id: outcome.runId,
          records: outcome.records.length,
          errors,
          spend_usd: outcome.spendUsd,
          aborted: outcome.aborted,
        });
      else
        log(
          `${outcome.runId}: ${outcome.records.length} judgments stored (${errors} errors), spend ~$${outcome.spendUsd.toFixed(4)}`,
        );
      program.setOptionValue("_exitCode", outcome.exitCode);
    });
  addGlobals(command);
};

const globalsOf = (command: Command): GlobalOptions => {
  const opts = command.optsWithGlobals<{
    config?: string;
    envFile?: string;
    json?: boolean;
    verbose?: boolean;
  }>();
  return {
    configPath: opts.config ?? DEFAULT_CONFIG_PATH,
    envFile: opts.envFile,
    json: opts.json ?? false,
    verbose: opts.verbose ?? false,
  };
};

export { executeRun, globalsOf, registerRun };
