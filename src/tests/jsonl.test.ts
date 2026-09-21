import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendJsonl, readJsonl } from "../io/jsonl.ts";

const tempDirs: string[] = [];

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "judgebench-jsonl-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("jsonl io", () => {
  it("appends and reads back records", async () => {
    const dir = await tempDir();
    const path = join(dir, "runs/x/judgments.jsonl");
    await appendJsonl(path, { a: 1 });
    await appendJsonl(path, { b: "two" });
    const records = await readJsonl(path);
    expect(records).toEqual([{ a: 1 }, { b: "two" }]);
  });

  it("creates parent directories on first append", async () => {
    const dir = await tempDir();
    const path = join(dir, "deep/nested/file.jsonl");
    await appendJsonl(path, { ok: true });
    const text = await readFile(path, "utf8");
    expect(text).toBe('{"ok":true}\n');
  });

  it("skips blank lines", async () => {
    const dir = await tempDir();
    const path = join(dir, "file.jsonl");
    await writeFile(path, '{"a":1}\n\n  \n{"b":2}\n', "utf8");
    expect(await readJsonl(path)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns [] for a missing file", async () => {
    const dir = await tempDir();
    expect(await readJsonl(join(dir, "missing.jsonl"))).toEqual([]);
  });
});
