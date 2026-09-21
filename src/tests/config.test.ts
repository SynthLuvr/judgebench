import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  configHash,
  parseJudge,
  resolveConfig,
} from "../core/config.ts";

const tempFiles: string[] = [];

const configPath = async (body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "judgebench-config-"));
  const path = join(dir, "judgebench.config.json");
  await writeFile(path, body, "utf8");
  tempFiles.push(dir);
  return path;
};

afterEach(async () => {
  for (const dir of tempFiles.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const BASE = {
  dataset: "mtbench",
  judges: ["openai/gpt-4o-mini"],
};

describe("parseJudge", () => {
  it("parses provider/model strings", () => {
    expect(parseJudge("openai/gpt-4o-mini")).toEqual({
      id: "openai/gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(parseJudge("anthropic/claude-haiku-4-5")?.provider).toBe(
      "anthropic",
    );
  });

  it("parses custom endpoint objects", () => {
    const judge = parseJudge({
      model: "grok-4",
      baseUrl: "https://api.x.ai/v1",
      apiKeyEnv: "XAI_API_KEY",
    });
    expect(judge.provider).toBe("custom");
    expect(judge.baseUrl).toBe("https://api.x.ai/v1");
    expect(judge.id).toBe("custom/grok-4");
  });

  it("parses named provider strings with endpoint presets", () => {
    expect(parseJudge("zai/glm-4.7-flashx")).toEqual({
      id: "zai/glm-4.7-flashx",
      provider: "zai",
      model: "glm-4.7-flashx",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKeyEnv: "ZAI_API_KEY",
    });
    expect(parseJudge("deepseek/deepseek-flash")).toMatchObject({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    });
    expect(parseJudge("opencode-go/deepseek-v4.1-flash")).toMatchObject({
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKeyEnv: "OPENCODE_API_KEY",
    });
  });

  it("parses local laya judges and rejects unknown checkpoints", () => {
    expect(parseJudge("laya/router")).toEqual({
      id: "laya/router",
      provider: "laya",
      model: "router",
    });
    expect(() => parseJudge("laya/gpt-4o")).toThrow(ConfigError);
    expect(() =>
      parseJudge({ provider: "laya", model: "english", baseUrl: "https://x" }),
    ).toThrow(ConfigError);
  });

  it("parses claude-code judges and rejects endpoint options", () => {
    expect(parseJudge("claude-code/claude-haiku-4-5")).toEqual({
      id: "claude-code/claude-haiku-4-5",
      provider: "claude-code",
      model: "claude-haiku-4-5",
    });
    expect(
      parseJudge({
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        label: "cc-sonnet",
      }),
    ).toEqual({
      id: "cc-sonnet",
      provider: "claude-code",
      model: "claude-sonnet-4-5",
    });
    expect(() =>
      parseJudge({
        provider: "claude-code",
        model: "claude-haiku-4-5",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      }),
    ).toThrow(ConfigError);
  });

  it("applies named presets to judge objects with overrides", () => {
    expect(
      parseJudge({ provider: "deepseek", model: "deepseek-flash" }),
    ).toEqual({
      id: "deepseek/deepseek-flash",
      provider: "deepseek",
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    });
    expect(
      parseJudge({
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        baseUrl: "http://localhost:4096/v1",
        label: "opencode-go-local/deepseek-v4.1-flash",
      }),
    ).toMatchObject({
      baseUrl: "http://localhost:4096/v1",
      apiKeyEnv: "OPENCODE_API_KEY",
      id: "opencode-go-local/deepseek-v4.1-flash",
    });
    expect(parseJudge({ model: "endpoint-model" }).provider).toBe("custom");
  });

  it("rejects malformed judge strings", () => {
    expect(() => parseJudge("gpt-4o-mini")).toThrow(ConfigError);
    expect(() => parseJudge("openai/")).toThrow(ConfigError);
    expect(() => parseJudge("weird/model")).toThrow(ConfigError);
    expect(() => parseJudge("claude-code-haiku/claude")).toThrow(/claude-code/);
  });
});

describe("resolveConfig", () => {
  it("fills defaults from a minimal config file", async () => {
    const path = await configPath(JSON.stringify(BASE));
    const resolved = await resolveConfig(path, {});
    expect(resolved.dataset).toBe("mtbench");
    expect(resolved.cells[0]?.answerMode).toBe("probabilities");
    expect(resolved.cells[0]?.structuredOutputs).toBe(true);
    expect(resolved.cells[0]?.labels).toEqual(["A", "B", "tie"]);
    expect(resolved.swap).toBe("both");
    expect(resolved.concurrency).toBe(8);
    expect(resolved.maxCorrectiveRetries).toBe(1);
    expect(resolved.normalizeProbabilities).toBe(true);
  });

  it("flags beat config file, config file beats defaults", async () => {
    const path = await configPath(
      JSON.stringify({ ...BASE, concurrency: 3, limit: 10 }),
    );
    const resolved = await resolveConfig(path, { concurrency: 5 });
    expect(resolved.concurrency).toBe(5);
    expect(resolved.limit).toBe(10);
  });

  it("expands matrix cells and overrides axes per cell", async () => {
    const path = await configPath(
      JSON.stringify({
        ...BASE,
        cells: [
          {},
          { answerMode: "discrete" },
          { structuredOutputs: false, labels: ["A", "B"] },
        ],
      }),
    );
    const resolved = await resolveConfig(path, {});
    expect(resolved.cells).toHaveLength(3);
    expect(resolved.cells[1]?.answerMode).toBe("discrete");
    expect(resolved.cells[1]?.structuredOutputs).toBe(true);
    expect(resolved.cells[2]?.labels).toEqual(["A", "B"]);
    expect(resolved.cells[2]?.answerMode).toBe("probabilities");
  });

  it("axis flags override every matrix cell", async () => {
    const path = await configPath(
      JSON.stringify({ ...BASE, cells: [{}, { answerMode: "discrete" }] }),
    );
    const resolved = await resolveConfig(path, { answerMode: "discrete" });
    expect(resolved.cells.every((cell) => cell.answerMode === "discrete")).toBe(
      true,
    );
  });

  it("dedupes identical cells after flag overrides", async () => {
    const path = await configPath(
      JSON.stringify({ ...BASE, cells: [{}, { answerMode: "probabilities" }] }),
    );
    const resolved = await resolveConfig(path, {});
    expect(resolved.cells).toHaveLength(1);
  });

  it("rejects invalid label sets", async () => {
    const path = await configPath(
      JSON.stringify({ ...BASE, labels: ["B", "A"] }),
    );
    await expect(resolveConfig(path, {})).rejects.toThrow(ConfigError);
  });

  it("rejects unknown config keys", async () => {
    const path = await configPath(JSON.stringify({ ...BASE, typo: 1 }));
    await expect(resolveConfig(path, {})).rejects.toThrow(/typo/);
  });

  it("rejects a missing config file", async () => {
    await expect(resolveConfig("/nonexistent.json", {})).rejects.toThrow(
      ConfigError,
    );
  });

  it("rejects duplicate judge ids", async () => {
    const path = await configPath(
      JSON.stringify({ ...BASE, judges: ["openai/a", "openai/a"] }),
    );
    await expect(resolveConfig(path, {})).rejects.toThrow(/duplicate/);
  });
});

describe("configHash", () => {
  it("is stable and distinguishes cells", async () => {
    const path = await configPath(JSON.stringify(BASE));
    const resolved = await resolveConfig(path, {});
    const judge = resolved.judges[0];
    if (judge === undefined) throw new Error("no judge");
    const cell = resolved.cells[0];
    if (cell === undefined) throw new Error("no cell");
    const hash = configHash(judge, cell, resolved);
    expect(hash).toBe(configHash(judge, cell, resolved));
    expect(hash).not.toBe(
      configHash(
        judge,
        { ...cell, structuredOutputs: !cell.structuredOutputs },
        resolved,
      ),
    );
  });
});
