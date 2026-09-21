import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

/** One selectable entry for `choose`. */
type PromptChoice<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
};

type AskOptions = {
  /** Returned when the user presses Enter on an empty line. */
  readonly default?: string;
  /** Empty input is accepted (returns ""). */
  readonly optional?: boolean;
};

/**
 * The interactive surface the configure wizard needs. Kept as an
 * interface so tests can script answers without a TTY (the Goose CLI
 * reaches for cliclack; judgebench stays dependency-free on readline).
 * `close` releases stdin when the session ends.
 */
type Prompts = {
  readonly choose: <T extends string>(
    message: string,
    choices: readonly PromptChoice<T>[],
  ) => Promise<T>;
  readonly ask: (message: string, options?: AskOptions) => Promise<string>;
  readonly secret: (message: string) => Promise<string>;
  readonly confirm: (message: string, initial?: boolean) => Promise<boolean>;
  readonly close: () => void;
};

const renderChoices = <T extends string>(
  choices: readonly PromptChoice<T>[],
  output: NodeJS.WritableStream,
): void => {
  choices.forEach((choice, index) => {
    output.write(`  ${index + 1}. ${choice.label}\n`);
    if (choice.hint !== undefined) output.write(`     ${choice.hint}\n`);
  });
};

type Waiter = {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
};

const closedError = (): Error =>
  new Error("input closed before an answer was entered");

/**
 * Build prompts on explicit streams. One readline session owns the
 * input for its lifetime and queues complete lines, so input that
 * arrives between prompts (fast typists, pasted answers) is never
 * dropped. Prompts render to `output` — never stdout, keeping
 * judgebench's stdout-contains-only-JSON discipline.
 */
const promptsOn = (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Prompts => {
  // terminal:true gives raw mode plus readline's line editing; the
  // wrapper is the interface's only output, so muting it silences the
  // echo (secrets) while everything judgebench renders itself stays
  // visible.
  const state = { muted: false, closed: false };
  const wrapper = new Writable({
    write: (chunk: Buffer | string, _encoding, callback) => {
      if (!state.muted) output.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input, output: wrapper, terminal: true });
  const queued: string[] = [];
  const waiters: Waiter[] = [];
  rl.on("line", (line: string) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(line);
    else queued.push(line);
  });
  // EOF or Ctrl+D must not strand a pending prompt: reject it so the
  // command exits (message + exit 2) instead of hanging forever.
  rl.on("close", () => {
    state.closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(closedError());
  });

  const say = (line: string): void => {
    output.write(`${line}\n`);
  };

  const nextLine = (): Promise<string> => {
    if (state.closed) return Promise.reject(closedError());
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };

  const choose = async <T extends string>(
    message: string,
    choices: readonly PromptChoice<T>[],
  ): Promise<T> => {
    for (;;) {
      say(message);
      renderChoices(choices, output);
      const answer = (await nextLine()).trim();
      const index = Number.parseInt(answer, 10);
      const choice =
        Number.isInteger(index) && index >= 1 && index <= choices.length
          ? choices[index - 1]
          : undefined;
      if (choice !== undefined) return choice.value;
      say(`  pick a number between 1 and ${choices.length}`);
    }
  };

  const ask = async (
    message: string,
    options: AskOptions = {},
  ): Promise<string> => {
    for (;;) {
      const suffix =
        options.default === undefined ? "" : ` (${options.default})`;
      output.write(`${message}${suffix}: `);
      const answer = (await nextLine()).trim();
      if (answer !== "") return answer;
      if (options.default !== undefined) return options.default;
      if (options.optional === true) return "";
      say("  a value is required (Ctrl+C to abort)");
    }
  };

  const secret = async (message: string): Promise<string> => {
    output.write(`${message}: `);
    state.muted = true;
    let answer: string;
    try {
      answer = await nextLine();
    } finally {
      state.muted = false;
    }
    say("  ********");
    return answer.trim();
  };

  const confirm = async (message: string, initial = true): Promise<boolean> => {
    for (;;) {
      output.write(`${message} (${initial ? "Y/n" : "y/N"}): `);
      const answer = (await nextLine()).trim().toLowerCase();
      if (answer === "") return initial;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  };

  const close = (): void => {
    rl.close();
  };

  return { choose, ask, secret, confirm, close };
};

/** The production prompts: stdin in, stderr out. Created lazily so
 * merely importing the module never touches stdin. */
const ttyPrompts = (): Prompts => promptsOn(process.stdin, process.stderr);

export type { AskOptions, PromptChoice, Prompts };
export { promptsOn, ttyPrompts };
