import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Append one JSON record as a JSONL line, creating parent directories. */
const appendJsonl = async (path: string, record: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
};

/** Read a JSONL file into parsed records; blank lines are skipped. */
const readJsonl = async (path: string): Promise<unknown[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed: unknown = JSON.parse(trimmed);
    records.push(parsed);
  }
  return records;
};

export { appendJsonl, readJsonl };
