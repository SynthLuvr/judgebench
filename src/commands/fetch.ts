import type { Command } from "commander";

import {
  type DatasetId,
  type FetchResult,
  fetchDataset,
} from "../core/dataset.ts";
import { emitJson, log } from "../io/output.ts";

import {
  CommandError,
  EXIT_CONFIG,
  EXIT_PROVIDER,
  flagNumber,
  flagString,
} from "./context.ts";
import { globalsOf } from "./run.ts";

const DATASETS: readonly DatasetId[] = ["mtbench", "arena", "canaries"];

/** Fetch a dataset, mapping upstream failures to the provider exit code. */
const fetchChecked = async (
  dataset: DatasetId,
  limit: number | null,
): Promise<FetchResult> => {
  try {
    return await fetchDataset("data", dataset, limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(
      `fetch ${dataset} failed: ${message}`,
      EXIT_PROVIDER,
    );
  }
};

const registerFetch = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("fetch")
    .description("download + normalize a dataset into data/<name>.jsonl")
    .requiredOption("--dataset <name>", `one of ${DATASETS.join(", ")}`)
    .option("--limit <n>", "stop after N normalized samples", (value) =>
      Number.parseInt(value, 10),
    )
    .action(async (flags: Record<string, unknown>, command: Command) => {
      const globals = globalsOf(command);
      const datasetName = flagString(flags.dataset);
      const dataset = DATASETS.find((candidate) => candidate === datasetName);
      if (dataset === undefined)
        throw new CommandError(
          `unknown dataset ${datasetName} — choose one of ${DATASETS.join(", ")}`,
          EXIT_CONFIG,
        );
      const limit = flagNumber(flags.limit) ?? null;
      const result = await fetchChecked(dataset, limit);
      const summary = {
        dataset,
        path: result.path,
        samples: result.samples.length,
        license: result.license,
        source: result.source,
      };
      if (globals.json) emitJson(summary);
      else {
        log(
          `fetched ${dataset}: ${result.samples.length} samples → ${result.path}`,
        );
        log(`source: ${result.source}`);
        log(
          result.license === null
            ? "license: generated locally, no third-party license applies"
            : `license: ${result.license} (recorded in data/${dataset}.meta.json)`,
        );
      }
      program.setOptionValue("_exitCode", 0);
    });
  addGlobals(command);
};

export { DATASETS, registerFetch };
