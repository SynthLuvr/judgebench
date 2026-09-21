import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DatasetError,
  generateCanaries,
  loadDataset,
  parseSample,
  writeDataset,
} from "../core/dataset.ts";

const tempDirs: string[] = [];

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "judgebench-data-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("generateCanaries", () => {
  it("is deterministic", () => {
    expect(generateCanaries(0xca4a5eed)).toEqual(generateCanaries(0xca4a5eed));
  });

  it("marks every clean response as A and injects into B", () => {
    const canaries = generateCanaries(0xca4a5eed);
    expect(canaries.length).toBeGreaterThanOrEqual(24);
    for (const canary of canaries) {
      expect(canary.human_label).toBe("A");
      expect(canary.response_b.startsWith(canary.response_a)).toBe(true);
      expect(canary.response_b.length).toBeGreaterThan(
        canary.response_a.length,
      );
    }
  });

  it("cycles distinct injection payloads", () => {
    const canaries = generateCanaries(0xca4a5eed);
    const injections = new Set(
      canaries.map((canary) =>
        canary.response_b.slice(canary.response_a.length),
      ),
    );
    expect(injections.size).toBeGreaterThan(3);
  });
});

describe("parseSample", () => {
  it("accepts a canonical sample", () => {
    const sample = parseSample(
      {
        id: "x",
        prompt: "p",
        response_a: "a",
        response_b: "b",
        human_label: "tie",
        model_a: "m1",
        model_b: "m2",
      },
      "test",
    );
    expect(sample.human_label).toBe("tie");
  });

  it("rejects bad labels and extra keys", () => {
    expect(() =>
      parseSample(
        {
          id: "x",
          prompt: "p",
          response_a: "a",
          response_b: "b",
          human_label: "Z",
        },
        "t",
      ),
    ).toThrow(DatasetError);
    expect(() =>
      parseSample(
        {
          id: "x",
          prompt: "p",
          response_a: "a",
          response_b: "b",
          human_label: "A",
          extra: 1,
        },
        "t",
      ),
    ).toThrow(DatasetError);
  });
});

describe("dataset io", () => {
  it("writes and loads with limits", async () => {
    const dir = await tempDir();
    const canaries = generateCanaries(0xca4a5eed);
    await writeDataset(dir, "canaries", canaries);
    const all = await loadDataset(dir, "canaries");
    expect(all).toHaveLength(canaries.length);
    const limited = await loadDataset(dir, "canaries", 5);
    expect(limited).toEqual(canaries.slice(0, 5));
  });

  it("errors helpfully on a missing dataset", async () => {
    const dir = await tempDir();
    await expect(loadDataset(dir, "mtbench")).rejects.toThrow(/fetch/);
  });
});
