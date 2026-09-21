import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatasetError, fetchDataset } from "../core/dataset.ts";

import { startJudgebenchMsw } from "./msw.ts";

const msw = startJudgebenchMsw();
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "judgebench-fetch-"));
});

afterAll(async () => {
  msw.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("fetchDataset", () => {
  it("normalizes mtbench human judgments with majority labels", async () => {
    const result = await fetchDataset(workDir, "mtbench", 9);
    expect(result.license).toBe("cc-by-4.0");
    expect(result.samples.length).toBeGreaterThan(0);
    const first = result.samples[0];
    if (first === undefined) throw new Error("no sample");
    expect(first.prompt).toContain("haiku");
    expect(first.response_a.length).toBeGreaterThan(0);
    expect(first.model_a).toBe("alpaca-13b");
    expect(["A", "B", "tie"]).toContain(first.human_label);
    // Grouping: three rows per (question, pair) majority into one sample.
    expect(result.samples.length).toBeLessThanOrEqual(3);
    const stored = await readFile(join(workDir, "mtbench.jsonl"), "utf8");
    expect(stored.split("\n").filter(Boolean)).toHaveLength(
      result.samples.length,
    );
    const meta = JSON.parse(
      await readFile(join(workDir, "mtbench.meta.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(meta.license).toBe("cc-by-4.0");
  });

  it("normalizes arena preferences with winner flags", async () => {
    const result = await fetchDataset(workDir, "arena", 5);
    expect(result.samples).toHaveLength(5);
    const first = result.samples[0];
    if (first === undefined) throw new Error("no sample");
    expect(first.id).toMatch(/^arena-\d+$/);
    expect(first.human_label).toBe("B");
    expect(first.response_a).toContain("2 + 2");
    expect(first.model_a).toBe("model-x");
  });

  it("generates canaries without network", async () => {
    const result = await fetchDataset(workDir, "canaries", null);
    expect(result.license).toBeNull();
    expect(result.samples.length).toBe(48);
  });

  it("throws a DatasetError for a broken upstream", async () => {
    const { http, HttpResponse } = await import("msw");
    msw.server.use(
      http.get("*/rows*", () => new HttpResponse(null, { status: 500 })),
    );
    await expect(fetchDataset(workDir, "mtbench", 5)).rejects.toThrow(
      DatasetError,
    );
  });
});
