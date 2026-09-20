import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";

import type { AnalysisResult } from "../analysis/metrics";
import { emitJson, log } from "../io/output";
import { latestRunId } from "./analyze";
import { CommandError, DEFAULT_RUNS_DIR, normalizeRunId } from "./context";
import { globalsOf } from "./run";

const fmt = (value: number | null | undefined, digits = 3): string =>
  value === null || value === undefined ? "—" : value.toFixed(digits);

const fmtCi = (ci: readonly [number, number]): string =>
  `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`;

const renderMarkdown = (analysis: AnalysisResult): string => {
  const lines: string[] = [];
  lines.push("# judgebench report", "");
  lines.push(
    `- runs: ${analysis.run_ids.join(", ")}`,
    `- dataset: ${analysis.dataset} · adapter: ${analysis.adapter_version ?? "unknown"} · bootstrap: ${analysis.bootstrap_reps} resamples`,
    "",
    "## Results by judge × configuration",
    "",
    "| judge | mode | structured | labels | rubric | agreement | debiased | single | flips | abstain | ECE | Brier | flip AUC | $/1k |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const group of analysis.groups)
    lines.push(
      [
        group.judge,
        group.axes.answerMode,
        String(group.axes.structuredOutputs),
        group.axes.labels.join("/"),
        group.axes.rubric ?? "off",
        fmt(group.agreement.point),
        fmt(group.agreement_debiased.point),
        fmt(group.agreement_single.point),
        fmt(group.flip_rate.point),
        fmt(group.abstain_rate),
        fmt(group.calibration.ece),
        fmt(group.calibration.brier),
        group.calibration.flip_auc === null
          ? "—"
          : fmt(group.calibration.flip_auc.point),
        group.tokens.cost_per_1k_judgments_usd === null
          ? "—"
          : `$${group.tokens.cost_per_1k_judgments_usd.toFixed(2)}`,
      ].join(" | "),
    );
  lines.push(
    "",
    "Agreement columns carry 95% bootstrap CIs: " +
      analysis.groups
        .map(
          (group) =>
            `${group.judge} ${group.agreement_debiased.point.toFixed(3)} ${fmtCi(group.agreement_debiased.ci95)}`,
        )
        .join("; "),
    "",
    "## Reliability",
    "",
    "| judge | mode | malformed retries/judgment | mean retries | error rate | p50 ms | p95 ms | in/judgment | out/judgment |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const group of analysis.groups)
    lines.push(
      [
        group.judge,
        group.axes.answerMode,
        fmt(group.reliability.malformed_retry_rate),
        fmt(group.reliability.mean_retries, 2),
        fmt(group.reliability.error_rate),
        String(Math.round(group.latency_ms.p50)),
        String(Math.round(group.latency_ms.p95)),
        String(Math.round(group.tokens.input_per_judgment)),
        String(Math.round(group.tokens.output_per_judgment)),
      ].join(" | "),
    );
  lines.push("", "## Cost–accuracy Pareto", "");
  lines.push(
    "| judge | mode | $/1k judgments | debiased agreement |",
    "| --- | --- | --- | --- |",
  );
  const pareto = [...analysis.pareto].sort(
    (a, b) =>
      (a.cost_per_1k_usd ?? Number.POSITIVE_INFINITY) -
      (b.cost_per_1k_usd ?? Number.POSITIVE_INFINITY),
  );
  for (const point of pareto)
    lines.push(
      [
        point.judge,
        point.axes.answerMode,
        point.cost_per_1k_usd === null
          ? "—"
          : `$${point.cost_per_1k_usd.toFixed(2)}`,
        `${fmt(point.agreement_debiased)} ${fmtCi(point.ci95)}`,
      ].join(" | "),
    );
  const { hypotheses } = analysis;
  lines.push("", "## Hypotheses", "");
  lines.push(
    `- **H1** (cheap judges ≈ published agreement at lower cost): cheapest scored judge ${hypotheses.h1.cheapest === null ? "n/a (no pricing)" : `${hypotheses.h1.cheapest.judge} at $${hypotheses.h1.cheapest.cost_per_1k.toFixed(2)}/1k with debiased agreement ${hypotheses.h1.cheapest.agreement.toFixed(3)}`}; span across cells ${hypotheses.h1.agreement_span === null ? "n/a" : hypotheses.h1.agreement_span.map((value) => value.toFixed(3)).join("–")}.`,
  );
  if (hypotheses.h2.length === 0)
    lines.push(
      "- **H2** (structured outputs kill malformed retries): no matched on/off pair in this analysis.",
    );
  for (const pair of hypotheses.h2)
    lines.push(
      `- **H2** ${pair.judge} (${pair.answerMode}): malformed retries ${pair.malformed_rate_structured.toFixed(3)} structured vs ${pair.malformed_rate_unstructured.toFixed(3)} prompted; agreement Δ ${fmt(pair.agreement_delta)}.`,
    );
  for (const pair of hypotheses.h3)
    lines.push(
      `- **H3** ${pair.judge}: swap-averaged minus single-order agreement ${fmt(pair.debiased_minus_single)}.`,
    );
  lines.push(
    `- **H4** (confidence predicts flips): flip AUC above 0.5 for ${hypotheses.h4.auc_above_half}/${hypotheses.h4.with_auc} scored configurations.`,
  );
  if (analysis.canaries !== null) {
    lines.push("", "## Injection robustness (canaries)", "");
    lines.push(
      `- injection followed: ${fmt(analysis.canaries.injection_followed_rate.point)} ${fmtCi(analysis.canaries.injection_followed_rate.ci95)}`,
    );
    lines.push(
      `- robust (picked the clean response): ${fmt(analysis.canaries.robustness_rate.point)} ${fmtCi(analysis.canaries.robustness_rate.ci95)} over n=${analysis.canaries.n}`,
    );
  }
  for (const group of analysis.groups)
    for (const warning of group.tokens.warnings)
      lines.push("", `> warning: ${group.judge}: ${warning}`);
  lines.push("");
  return lines.join("\n");
};

const renderCsv = (analysis: AnalysisResult): string => {
  const header = [
    "judge",
    "answer_mode",
    "structured",
    "labels",
    "rubric",
    "agreement",
    "agreement_ci_low",
    "agreement_ci_high",
    "agreement_debiased",
    "agreement_single",
    "flip_rate",
    "abstain_rate",
    "ece",
    "brier",
    "flip_auc",
    "cost_per_1k_usd",
    "malformed_retry_rate",
    "error_rate",
    "p50_ms",
    "p95_ms",
  ];
  const rows = analysis.groups.map((group) =>
    [
      group.judge,
      group.axes.answerMode,
      String(group.axes.structuredOutputs),
      group.axes.labels.join("/"),
      group.axes.rubric ?? "off",
      group.agreement.point,
      group.agreement.ci95[0],
      group.agreement.ci95[1],
      group.agreement_debiased.point,
      group.agreement_single.point,
      group.flip_rate.point,
      group.abstain_rate,
      group.calibration.ece,
      group.calibration.brier,
      group.calibration.flip_auc?.point ?? "",
      group.tokens.cost_per_1k_judgments_usd ?? "",
      group.reliability.malformed_retry_rate,
      group.reliability.error_rate,
      group.latency_ms.p50,
      group.latency_ms.p95,
    ].join(","),
  );
  return [header.join(","), ...rows].join("\n");
};

const registerReport = (
  program: Command,
  addGlobals: (command: Command) => void,
): void => {
  const command = program
    .command("report")
    .description("render markdown/CSV tables + Pareto data from analysis")
    .option("--format <fmt>", "md, csv, or json")
    .option("--out <dir>", "output directory (default reports/)")
    .option("--runs <ids...>", "report these analyzed runs (default: latest)")
    .action(async (flags: Record<string, unknown>, command: Command) => {
      const globals = globalsOf(command);
      const format = (flags.format as string | undefined) ?? "md";
      if (!["md", "csv", "json"].includes(format))
        throw new CommandError(`--format must be md, csv, or json`, 2);
      const outDir = (flags.out as string | undefined) ?? "reports";
      const requested = (flags.runs as string[] | undefined) ?? [];
      const runKey =
        requested.length > 0
          ? requested.map(normalizeRunId).join("+")
          : ((await latestRunId(DEFAULT_RUNS_DIR)) ?? "");
      const analysisPath = `${DEFAULT_RUNS_DIR}/${runKey}/analysis.json`;
      let analysis: AnalysisResult;
      try {
        analysis = JSON.parse(
          await readFile(analysisPath, "utf8"),
        ) as AnalysisResult;
      } catch {
        throw new CommandError(
          `cannot read ${analysisPath} — run \`judgebench analyze --runs ${runKey}\` first`,
          2,
        );
      }
      await mkdir(outDir, { recursive: true });
      const base = `REPORT-${runKey}`;
      if (format === "json") emitJson(analysis);
      if (format === "md" || format === "json") {
        const path = `${outDir}/${base}.md`;
        await writeFile(path, renderMarkdown(analysis), "utf8");
        if (!globals.json) log(`wrote ${path}`);
      }
      if (format === "csv" || format === "json") {
        const path = `${outDir}/${base}.csv`;
        await writeFile(path, `${renderCsv(analysis)}\n`, "utf8");
        if (!globals.json) log(`wrote ${path}`);
      }
      program.setOptionValue("_exitCode", 0);
    });
  addGlobals(command);
};

export { registerReport, renderCsv, renderMarkdown };
