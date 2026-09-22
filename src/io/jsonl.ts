import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Append one JSON record as a JSONL line, creating parent directories. */
const appendJsonl = async (path: string, record: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
};

/** Read a JSONL file into parsed records; blank lines are skipped.
 * With a type guard, every record must satisfy it — a failing record
 * raises with its line number instead of flowing on unverified. */
async function readJsonl(path: string): Promise<unknown[]>;
async function readJsonl<T>(
  path: string,
  isRecord: (value: unknown) => value is T,
): Promise<T[]>;
async function readJsonl<T>(
  path: string,
  isRecord?: (value: unknown) => value is T,
): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord !== undefined && !isRecord(parsed))
      throw new Error(`${path}: invalid record at line ${index + 1}`);
    records.push(parsed);
  }
  return records;
}

export { appendJsonl, readJsonl };
