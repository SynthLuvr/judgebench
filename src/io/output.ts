const log = (...parts: readonly unknown[]): void => {
  console.error(...parts);
};

const verboseLog = (verbose: boolean, ...parts: readonly unknown[]): void => {
  if (verbose) console.error(...parts);
};

const emitJson = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const emitText = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

/** Progress and diagnostics go to stderr so stdout stays pipeable; `--json`
 * output is the only thing written to stdout. */
const progress = (line: string): void => {
  if (process.stderr.isTTY) console.error(`\r${line}`);
  else console.error(line);
};

const progressDone = (): void => {
  if (process.stderr.isTTY) console.error();
};

export { emitJson, emitText, log, progress, progressDone, verboseLog };
