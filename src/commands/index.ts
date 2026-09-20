import { analyzeCommand } from "./analyze";
import type { Command, CommandContext } from "./command";
import { EXIT_CONFIG } from "./command";
import { estimateCommand } from "./estimate";
import { fetchCommand } from "./fetch";
import { replayCommand } from "./replay";
import { reportCommand } from "./report";
import { runCommand } from "./run";
import { smokeCommand } from "./smoke";
import { validateCommand } from "./validate";

const commands: readonly Command[] = [
  fetchCommand,
  validateCommand,
  estimateCommand,
  runCommand,
  analyzeCommand,
  reportCommand,
  smokeCommand,
  replayCommand,
];

const usage = (error?: string): number => {
  if (error !== undefined) console.error(`judgebench: ${error}`);
  console.error("usage: judgebench <command> [flags]");
  for (const command of commands)
    console.error(`  ${command.name.padEnd(9)} ${command.description}`);
  return EXIT_CONFIG;
};

const parseGlobals = (args: readonly string[]): CommandContext => {
  // TODO: node:util parseArgs for --config, --env-file, --json, --verbose
  return { args, json: false, verbose: false };
};

const main = async (argv: readonly string[]): Promise<number> => {
  const [name, ...rest] = argv;
  if (name === undefined || name.startsWith("-")) return usage();
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) return usage(`unknown command: ${name}`);
  return command.run(parseGlobals(rest));
};

export { commands, main };
