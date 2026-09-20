import type { Command } from "commander";

import { type JudgeSpec, resolveConfig } from "../core/config";
import { loadPricing, pricingWarnings, projectCost } from "../core/cost";
import { loadDataset, type Sample } from "../core/dataset";
import { buildClient, judgeSample } from "../core/judge";
import { ordersFor } from "../core/swap";
import { emitJson, log } from "../io/output";

import { CommandError, DEFAULT_DATA_DIR, EXIT_PROVIDER } from "./context";
import { globalsOf } from "./run";

/** Run a small live pilot (5 samples) per judge and extrapolate. */
const registerEstimate = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("estimate")
    .description(
      "project run cost via a small live pilot, not a chars/4 heuristic",
    )
    .option("--judge <provider/model...>", "estimate only these judges")
    .option("--limit <n>", "pilot sample size", (value) =>
      Number.parseInt(value, 10),
    )
    .action(async (flags: Record<string, unknown>, command: Command) => {
      const globals = globalsOf(command);
      const resolved = await resolveConfig(globals.configPath, {
        judges: flags.judge as string[] | undefined,
      });
      const samples = await loadDataset(
        DEFAULT_DATA_DIR,
        resolved.dataset,
        resolved.limit,
      );
      const pilotSize = flags.limit === undefined ? 5 : (flags.limit as number);
      const pilot: readonly Sample[] = samples.slice(0, pilotSize);
      if (pilot.length === 0)
        throw new CommandError(
          `dataset ${resolved.dataset} is empty — run \`judgebench fetch --dataset ${resolved.dataset}\` first`,
          2,
        );
      const pricing = await loadPricing();
      const orders = ordersFor(
        pilot[0]?.id ?? "pilot",
        resolved.swap,
        resolved.seed,
      );
      const judgmentsPerSample = orders.length;
      const plannedSamples = resolved.limit ?? samples.length;

      const rows: Record<string, unknown>[] = [];
      for (const judge of resolved.judges) {
        const cell = resolved.cells[0];
        if (cell === undefined) continue;
        let inputTokens = 0;
        let outputTokens = 0;
        let calls = 0;
        let errors = 0;
        const client = buildClient(judge, cell, resolved);
        try {
          for (const sample of pilot)
            for (const order of ordersFor(
              sample.id,
              resolved.swap,
              resolved.seed,
            )) {
              const record = await judgeSample(
                client,
                sample,
                order,
                cell,
                judge.id,
                "pilot",
                null,
              );
              calls += 1;
              if (record.usage !== null) {
                inputTokens += record.usage.input_tokens_total;
                outputTokens += record.usage.output_tokens_total;
              }
              if (record.error !== null) {
                errors += 1;
                log(
                  `warning: pilot call failed (${record.error_type}): ${record.error}`,
                );
              }
            }
        } finally {
          await client.close();
        }
        if (errors === calls)
          throw new CommandError(
            `every pilot call for ${judge.id} failed — provider/network error`,
            EXIT_PROVIDER,
          );
        const meanUsage = {
          input_tokens_total: calls === 0 ? 0 : inputTokens / calls,
          output_tokens_total: calls === 0 ? 0 : outputTokens / calls,
        };
        const totalJudgments =
          plannedSamples * judgmentsPerSample * resolved.cells.length;
        const projected = projectCost(
          pricing,
          judge.id,
          meanUsage,
          totalJudgments,
        );
        rows.push({
          judge: judge.id,
          pilot_calls: calls,
          pilot_errors: errors,
          mean_input_tokens: Math.round(meanUsage.input_tokens_total),
          mean_output_tokens: Math.round(meanUsage.output_tokens_total),
          judgments_per_sample: judgmentsPerSample,
          cells: resolved.cells.length,
          planned_samples: plannedSamples,
          projected_cost_usd:
            projected === null ? null : Number(projected.toFixed(2)),
        });
      }

      const warnings = pricingWarnings(
        pricing,
        resolved.judges.map((judge: JudgeSpec) => judge.id),
        new Date(),
      );
      const total = rows.reduce(
        (sum, row) =>
          sum +
          (row.projected_cost_usd === null
            ? 0
            : (row.projected_cost_usd as number)),
        0,
      );
      if (globals.json)
        emitJson({
          rows,
          warnings,
          total_projected_cost_usd: Number(total.toFixed(2)),
        });
      else {
        log(
          `pilot: ${pilot.length} samples × ${judgmentsPerSample} orders per judge, first cell only`,
        );
        for (const row of rows)
          log(
            `${String(row.judge).padEnd(32)} ~${String(row.mean_input_tokens)} in / ~${String(row.mean_output_tokens)} out per judgment → projected $${String(row.projected_cost_usd)} for ${String(row.planned_samples)} samples × ${String(row.cells)} cells`,
          );
        log(`total projected: $${total.toFixed(2)}`);
        for (const warning of warnings) log(`warning: ${warning}`);
      }
      program.setOptionValue("_exitCode", 0);
    });
  addGlobals(command);
};

export { registerEstimate };
