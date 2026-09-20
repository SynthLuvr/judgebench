const EXIT_OK = 0;
const EXIT_CONFIG = 2;
const EXIT_PROVIDER = 3;
const EXIT_COST = 4;

type CommandContext = {
  readonly args: readonly string[];
  readonly configPath?: string;
  readonly json: boolean;
  readonly verbose: boolean;
};

type Command = {
  readonly name: string;
  readonly description: string;
  readonly run: (ctx: CommandContext) => Promise<number>;
};

// Shared scaffold shell for the command stubs: every command exits 2 with
// a note until its implementation phase replaces `run`.
const defineCommand = (name: string, description: string): Command => ({
  name,
  description,
  run: async () => {
    console.error(`${name}: not implemented (scaffold)`);
    return EXIT_CONFIG;
  },
});

export type { Command, CommandContext };
export { defineCommand, EXIT_CONFIG, EXIT_COST, EXIT_OK, EXIT_PROVIDER };
