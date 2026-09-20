import { access } from "node:fs/promises";
import type { Command } from "commander";

import { resolveConfig } from "../core/config";
import {
  loadPricing,
  PRICING_MAX_AGE_DAYS,
  priceFor,
  pricingAgeDays,
} from "../core/cost";
import { type DatasetId, loadDataset } from "../core/dataset";
import { emitJson, log } from "../io/output";

import { CommandError, DEFAULT_DATA_DIR, providerEnvKey } from "./context";
import { globalsOf } from "./run";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const registerValidate = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("validate")
    .description(
      "static checks: dataset schema, config resolution, API keys present",
    )
    .option(
      "--dataset <name>",
      "check this dataset instead of the configured one",
    )
    .action(async (flags: Record<string, unknown>, command: Command) => {
      const globals = globalsOf(command);
      const problems: string[] = [];
      const notes: string[] = [];

      const resolved = await resolveConfig(globals.configPath, {});
      notes.push(
        `config ${globals.configPath}: ${resolved.judges.length} judges × ${resolved.cells.length} cells, dataset ${resolved.dataset}, swap=${resolved.swap}`,
      );

      const dataset = (flags.dataset as string | undefined) ?? resolved.dataset;
      const path = `${DEFAULT_DATA_DIR}/${dataset}.jsonl`;
      if (await fileExists(path))
        try {
          const samples = await loadDataset(
            DEFAULT_DATA_DIR,
            dataset as DatasetId,
          );
          notes.push(`${path}: ${samples.length} samples valid`);
          const metaExists = await fileExists(
            `${DEFAULT_DATA_DIR}/${dataset}.meta.json`,
          );
          if (!metaExists)
            notes.push(
              `${dataset}: no license metadata (run \`judgebench fetch --dataset ${dataset}\` to record it)`,
            );
        } catch (error) {
          problems.push(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      else
        problems.push(
          `${path} missing — run \`judgebench fetch --dataset ${dataset}\` first`,
        );

      for (const judge of resolved.judges) {
        const envKey =
          judge.provider === "custom"
            ? (judge.apiKeyEnv ?? "OPENAI_API_KEY")
            : providerEnvKey(judge.provider);
        if (envKey === null) continue;
        if (process.env[envKey] === undefined || process.env[envKey] === "")
          problems.push(`${envKey} not set — required by judge ${judge.id}`);
        else notes.push(`${envKey} present for ${judge.id}`);
        if (judge.provider === "custom" && judge.baseUrl === undefined)
          notes.push(
            `judge ${judge.id} uses the SDK's default base URL resolution`,
          );
      }

      const pricing = await loadPricing();
      const now = new Date();
      for (const judge of resolved.judges) {
        const entry = priceFor(pricing, judge.id);
        if (entry === null)
          notes.push(
            `no pricing entry for ${judge.id} — costs will be excluded`,
          );
        else if (pricingAgeDays(entry, now) > PRICING_MAX_AGE_DAYS)
          notes.push(
            `pricing for ${judge.id} is ${Math.round(pricingAgeDays(entry, now))} days old — verify against provider billing`,
          );
      }

      if (globals.json)
        emitJson({ ok: problems.length === 0, problems, notes });
      else for (const note of notes) log(`ok: ${note}`);
      if (problems.length > 0) {
        for (const problem of problems) log(`problem: ${problem}`);
        throw new CommandError("validation failed", 2);
      }
      log("validation passed");
      program.setOptionValue("_exitCode", 0);
    });
  addGlobals(command);
};

export { registerValidate };
