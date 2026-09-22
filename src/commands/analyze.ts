import { mkdir, readdir, writeFile } from "node:fs/promises";
import type { Command } from "commander";

import { type AnalysisResult, computeMetrics } from "../analysis/metrics.ts";
import { loadPricing } from "../core/cost.ts";
import { loadDataset, type Sample } from "../core/dataset.ts";
import { isJudgmentRecord, type JudgmentRecord } from "../core/judge.ts";
import { readJsonl } from "../io/jsonl.ts";
import { readManifest } from "../io/manifest.ts";
import { emitJson, log } from "../io/output.ts";

import {
  CommandError,
  DEFAULT_DATA_DIR,
  DEFAULT_RUNS_DIR,
  flagNumber,
  flagStringOption,
  flagStrings,
  normalizeRunId,
} from "./context.ts";

import { DATASETS } from "./fetch.ts";
import { globalsOf } from "./run.ts";

/** Newest run directory id, for the default `--runs` behavior. */
const latestRunId = async (runsDir: string): Promise<string | null> => {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return null;
  }
  const runIds = entries.filter((entry) => entry.startsWith("run-")).sort();
  return runIds[runIds.length - 1] ?? null;
};

/** Records and dataset identity gathered from the analyzed runs. */
type RunInputs = {
  readonly records: readonly JudgmentRecord[];
  readonly datasetName: string;
  readonly adapterVersion: string | null;
};

const collectRunInputs = async (
  runIds: readonly string[],
): Promise<RunInputs> => {
  const records: JudgmentRecord[] = [];
  let datasetName: string | null = null;
  let adapterVersion: string | null = null;
  for (const runId of runIds) {
    const runDir = `${DEFAULT_RUNS_DIR}/${runId}`;
    const manifest = await readManifest(runDir).catch(() => {
      throw new CommandError(`no manifest.json in ${runDir}`, 2);
    });
    if (datasetName === null) {
      datasetName = manifest.dataset.name;
      adapterVersion = manifest.adapter_version;
    } else if (datasetName !== manifest.dataset.name)
      throw new CommandError(
        `cannot mix datasets across runs: ${datasetName} vs ${manifest.dataset.name}`,
        2,
      );

    const runRecords = await readJsonl(
      `${runDir}/judgments.jsonl`,
      isJudgmentRecord,
    );
    if (runRecords.length === 0) log(`warning: run ${runId} has no judgments`);
    records.push(...runRecords);
  }
  if (datasetName === null)
    throw new CommandError(
      "no runs analyzed — cannot determine the dataset",
      2,
    );
  return { records, datasetName, adapterVersion };
};

/** Samples by id; empty when the dataset is no longer on disk. */
const loadSamplesById = async (
  datasetName: string,
): Promise<Map<string, Sample>> => {
  const byId = new Map<string, Sample>();
  const dataset = DATASETS.find((candidate) => candidate === datasetName);
  const samples =
    dataset === undefined
      ? null
      : await loadDataset(DEFAULT_DATA_DIR, dataset).catch(() => null);
  if (samples === null) {
    log(
      `warning: dataset ${datasetName} unavailable — model joins and slices disabled`,
    );
    return byId;
  }
  for (const sample of samples) byId.set(sample.id, sample);
  return byId;
};

const registerAnalyze = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("analyze")
    .description("metrics from judgment files → analysis.json")
    .option("--runs <ids...>", "run ids to analyze (default: latest)")
    .option("--bootstrap <n>", "bootstrap resamples for CIs", (value) =>
      Number.parseInt(value, 10),
    )
    .option("--filter <expr>", "sample slice, e.g. model_a==model_b")
    .action(async (flags: Record<string, unknown>, command: Command) => {
      const globals = globalsOf(command);
      const requested = flagStrings(flags.runs) ?? [];
      const latest =
        requested.length > 0 ? null : await latestRunId(DEFAULT_RUNS_DIR);
      if (requested.length === 0 && latest === null)
        throw new CommandError(
          "no runs found under runs/ — run `judgebench run` first",
          2,
        );
      const runIds =
        requested.length > 0
          ? requested.map(normalizeRunId)
          : latest !== null
            ? [latest]
            : [];
      const bootstrapReps = flagNumber(flags.bootstrap) ?? 2000;
      if (bootstrapReps <= 0)
        throw new CommandError("--bootstrap must be a positive integer", 2);
      const filter = flagStringOption(flags.filter);
      if (filter !== undefined && filter !== "model_a==model_b")
        throw new CommandError(
          `unsupported --filter ${filter} — only model_a==model_b`,
          2,
        );

      const { records, datasetName, adapterVersion } =
        await collectRunInputs(runIds);
      if (records.length === 0)
        throw new CommandError(
          "no judgment records found in the selected runs",
          2,
        );

      const pricing = await loadPricing();
      const analysis: AnalysisResult = computeMetrics(
        records,
        await loadSamplesById(datasetName),
        runIds,
        datasetName,
        adapterVersion,
        {
          bootstrapReps,
          seed: 0xfeed_beef,
          selfPreferenceFilter: filter === "model_a==model_b",
          now: new Date(),
        },
        pricing,
      );

      const outDir = `${DEFAULT_RUNS_DIR}/${runIds.join("+")}`;
      const analysisPath = `${outDir}/analysis.json`;
      await mkdir(outDir, { recursive: true });
      await writeFile(
        analysisPath,
        `${JSON.stringify(analysis, null, 2)}\n`,
        "utf8",
      );

      if (globals.json) emitJson(analysis);
      else {
        log(
          `analysis of ${records.length} judgments from ${runIds.join(", ")} → ${analysisPath}`,
        );
        for (const group of analysis.groups)
          log(
            `${group.judge} [${group.axes.answerMode}/structured=${group.axes.structuredOutputs}/labels=${group.axes.labels.join("|")}/rubric=${group.axes.rubric ?? "off"}]: agreement ${group.agreement.point.toFixed(3)}, debiased ${group.agreement_debiased.point.toFixed(3)}, flips ${group.flip_rate.point.toFixed(3)}, ece ${group.calibration.ece.toFixed(3)}`,
          );
        for (const group of analysis.groups)
          for (const warning of group.tokens.warnings)
            log(`warning: ${group.judge}: ${warning}`);
      }
      program.setOptionValue("_exitCode", 0);
    });
  addGlobals(command);
};

export { latestRunId, registerAnalyze };
