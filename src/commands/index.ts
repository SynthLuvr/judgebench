import { Command } from "commander";
import { registerAnalyze } from "./analyze.ts";
import { CommandError, loadEnvFile } from "./context.ts";
import { registerEstimate } from "./estimate.ts";
import { registerFetch } from "./fetch.ts";
import { registerReplay } from "./replay.ts";
import { registerReport } from "./report.ts";
import { registerRun } from "./run.ts";
import { registerValidate } from "./validate.ts";

/** Global flags every subcommand also accepts (flag-anywhere ergonomics). */
const addGlobals = (command: Command): void => {
  command
    .option(
      "--config <path>",
      "config file path (default judgebench.config.json)",
    )
    .option("--env-file <path>", "KEY=VALUE file loaded before running")
    .option("--json", "machine-readable stdout")
    .option("--verbose", "debug logging to stderr");
};

/** The documented command surface, in reference-table order. */
const COMMAND_NAMES = [
  "fetch",
  "validate",
  "estimate",
  "run",
  "analyze",
  "report",
  "replay",
] as const;

/** Build a fresh commander program with every command registered. */
const buildProgram = (): Command => {
  const program = new Command();
  program
    .name("judgebench")
    .description(
      "LLM-as-judge benchmark CLI: agreement, position bias, calibration, cost, reliability",
    )
    .enablePositionalOptions();
  addGlobals(program);
  // Load the env file before any command action runs, wherever the flag sits.
  program.hook("preAction", async (_programCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals<{ envFile?: string }>();
    if (opts.envFile !== undefined) {
      const loaded = await loadEnvFile(opts.envFile);
      for (const key of loaded)
        process.stderr.write(
          `judgebench: loaded ${key} from ${opts.envFile}\n`,
        );
    }
  });
  registerFetch(program, addGlobals);
  registerValidate(program, addGlobals);
  registerEstimate(program, addGlobals);
  registerRun(program, addGlobals);
  registerAnalyze(program, addGlobals);
  registerReport(program, addGlobals);
  registerReplay(program, addGlobals);
  return program;
};

/** Whether a commander error code is just help/version output. */
const helpCode = (code: string): boolean =>
  code === "commander.helpDisplayed" ||
  code === "commander.help" ||
  code === "commander.version";

/** Parse argv and return the process exit code without exiting. */
const main = async (argv: readonly string[]): Promise<number> => {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: (chunk: string) => process.stderr.write(chunk),
    writeErr: (chunk: string) => process.stderr.write(chunk),
  });
  try {
    await program.parseAsync(argv, { from: "user" });
    const outcome = program.getOptionValue("_exitCode");
    return typeof outcome === "number" ? outcome : 0;
  } catch (error) {
    return exitCodeOf(error);
  }
};

/** Map a thrown error to the process exit code, logging when needed. */
const exitCodeOf = (error: unknown): number => {
  if (error instanceof CommandError) {
    process.stderr.write(`judgebench: ${error.message}\n`);
    return error.exitCode;
  }
  const code = (error as { code?: string }).code ?? "";
  if (code.startsWith("commander.")) return helpCode(code) ? 0 : 2;

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`judgebench: ${message}\n`);
  return 2;
};

export { buildProgram, COMMAND_NAMES, main };
