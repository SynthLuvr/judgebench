import { readdir } from "node:fs/promises";
import type { Command } from "commander";

import { type AnalysisResult, computeMetrics } from "../analysis/metrics";
import { loadPricing } from "../core/cost";
import { loadDataset, type Sample } from "../core/dataset";
import type { JudgmentRecord } from "../core/judge";
import { readJsonl } from "../io/jsonl";
import { readManifest } from "../io/manifest";
import { emitJson, log } from "../io/output";

import { CommandError, DEFAULT_DATA_DIR, DEFAULT_RUNS_DIR } from "./context";
import { globalsOf } from "./run";

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
      const requested = (flags.runs as string[] | undefined) ?? [];
      const latest =
        requested.length > 0 ? null : await latestRunId(DEFAULT_RUNS_DIR);
      if (requested.length === 0 && latest === null)
        throw new CommandError(
          "no runs found under runs/ — run `judgebench run` first",
          2,
        );
      const runIds =
        requested.length > 0
          ? requested.map((id) => id.replace(/^runs\//, "").replace(/\/$/, ""))
          : [latest as string];
      const bootstrapReps =
        flags.bootstrap === undefined ? 2000 : (flags.bootstrap as number);
      if (bootstrapReps <= 0)
        throw new CommandError("--bootstrap must be a positive integer", 2);
      const filter = flags.filter as string | undefined;
      if (filter !== undefined && filter !== "model_a==model_b")
        throw new CommandError(
          `unsupported --filter ${filter} — only model_a==model_b`,
          2,
        );

      const records: JudgmentRecord[] = [];
      const samplesById = new Map<string, Sample>();
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

        const runRecords = (await readJsonl(
          `${runDir}/judgments.jsonl`,
        )) as JudgmentRecord[];
        if (runRecords.length === 0)
          log(`warning: run ${runId} has no judgments`);
        records.push(...runRecords);
      }
      if (records.length === 0)
        throw new CommandError(
          "no judgment records found in the selected runs",
          2,
        );

      try {
        const samples = await loadDataset(
          DEFAULT_DATA_DIR,
          datasetName as "mtbench",
        );
        for (const sample of samples) samplesById.set(sample.id, sample);
      } catch {
        log(
          `warning: dataset ${datasetName} unavailable — model joins and slices disabled`,
        );
      }

      const pricing = await loadPricing();
      const analysis: AnalysisResult = computeMetrics(
        records,
        samplesById,
        runIds,
        datasetName as string,
        adapterVersion,
        {
          bootstrapReps,
          seed: 0xfeed_beef,
          selfPreferenceFilter: filter === "model_a==model_b",
          now: new Date(),
        },
        pricing,
      );

      const analysisPath = `${DEFAULT_RUNS_DIR}/${runIds.join("+")}/analysis.json`;
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(`${DEFAULT_RUNS_DIR}/${runIds.join("+")}`, {
        recursive: true,
      });
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
