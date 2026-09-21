import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { runWizard } from "../commands/configure.ts";
import { main } from "../commands/index.ts";
import {
  maskSecret,
  parseEnvText,
  readEnvFile,
  updateEnvKeys,
} from "../core/envfile.ts";
import type { Prompts } from "../io/prompt.ts";

/** Answers fed to a wizard run, consumed in call order per method. */
type Script = {
  readonly choose?: readonly string[];
  readonly ask?: readonly string[];
  readonly secret?: readonly string[];
  readonly confirm?: readonly boolean[];
};

const scriptedPrompts = (script: Script): Prompts => {
  const counters = { choose: 0, ask: 0, secret: 0, confirm: 0 };
  return {
    choose: async (_message, choices) => {
      const wanted = script.choose?.[counters.choose++];
      if (wanted === undefined) throw new Error("script ran out of choices");
      const match = choices.find((choice) => choice.value === wanted);
      if (match === undefined)
        throw new Error(`scripted choice ${wanted} was not offered`);
      return match.value;
    },
    ask: async (_message, options) => {
      const answer = script.ask?.[counters.ask++];
      return answer ?? options?.default ?? "";
    },
    secret: async () => script.secret?.[counters.secret++] ?? "s3cret-value",
    confirm: async () => script.confirm?.[counters.confirm++] ?? true,
    close: () => undefined,
  };
};

const dirs: string[] = [];

const tmp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "judgebench-configure-"));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Spy on a stdio stream, capturing everything written to it. */
const captureStream = (
  stream: NodeJS.WriteStream,
): { text: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(stream, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
};

/** Spy on the log() channel (console.error). */
const captureLog = (): { text: () => string; restore: () => void } => {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: readonly unknown[]) => {
      chunks.push(parts.map(String).join(" "));
    });
  return { text: () => chunks.join("\n"), restore: () => spy.mockRestore() };
};

const withEnv = async <T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
};

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

describe("env file helpers", () => {
  it("creates a new keys file with a header and mode 0600", async () => {
    const dir = await tmp();
    const path = join(dir, ".env");
    const changed = await updateEnvKeys(path, [
      { key: "OPENAI_API_KEY", value: "sk-test-123456" },
    ]);
    expect(changed).toEqual(["OPENAI_API_KEY"]);
    const text = await readFile(path, "utf8");
    expect(text).toContain("judgebench configure");
    expect(text).toContain("OPENAI_API_KEY=sk-test-123456");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves foreign lines and comments when updating", async () => {
    const dir = await tmp();
    const path = join(dir, ".env");
    await writeFile(path, "# top comment\nOTHER=x\nOPENAI_API_KEY=old\n");
    await updateEnvKeys(path, [{ key: "OPENAI_API_KEY", value: "new" }]);
    const text = await readFile(path, "utf8");
    expect(text).toContain("# top comment");
    expect(text).toContain("OTHER=x");
    expect(text).toContain("OPENAI_API_KEY=new");
    expect(text).not.toContain("=old");
  });

  it("removes only the requested key", async () => {
    const dir = await tmp();
    const path = join(dir, ".env");
    await writeFile(path, "A_KEY=1\nB_KEY=2\n");
    const changed = await updateEnvKeys(path, [{ key: "A_KEY", value: null }]);
    expect(changed).toEqual(["A_KEY"]);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("A_KEY");
    expect(text).toContain("B_KEY=2");
  });

  it("reports no change when the stored value already matches", async () => {
    const dir = await tmp();
    const path = join(dir, ".env");
    await updateEnvKeys(path, [{ key: "A_KEY", value: "1" }]);
    expect(await updateEnvKeys(path, [{ key: "A_KEY", value: "1" }])).toEqual(
      [],
    );
  });

  it("parses export prefixes, quotes, and skips comments", () => {
    expect(parseEnvText('export A="1 2"\n# c\nB=3\nplain junk\n')).toEqual([
      { key: "A", value: "1 2" },
      { key: "B", value: "3" },
    ]);
  });

  it("masks secrets for display", () => {
    expect(maskSecret("short")).toBe("••••••");
    expect(maskSecret("sk-1234567890abcd")).toBe("sk-1••••abcd");
  });
});

describe("configure flags", () => {
  it("writes the judge list and creates a fresh config", async () => {
    const dir = await tmp();
    const config = join(dir, "config.json");
    const err = captureStream(process.stderr);
    const code = await main([
      "configure",
      "--config",
      config,
      "--judge",
      "openai/gpt-4o-mini",
    ]);
    err.restore();
    expect(code).toBe(0);
    expect(await readJson(config)).toEqual({
      dataset: "canaries",
      judges: ["openai/gpt-4o-mini"],
    });
  });

  it("preserves unrelated config keys when setting judges", async () => {
    const dir = await tmp();
    const config = join(dir, "config.json");
    await writeFile(
      config,
      `${JSON.stringify({
        dataset: "arena",
        judges: ["openai/gpt-4o-mini"],
        swap: "single",
      })}\n`,
    );
    const err = captureStream(process.stderr);
    const code = await main([
      "configure",
      "--config",
      config,
      "--judge",
      "anthropic/claude-haiku-4-5",
    ]);
    err.restore();
    expect(code).toBe(0);
    const doc = await readJson(config);
    expect(doc.dataset).toBe("arena");
    expect(doc.swap).toBe("single");
    expect(doc.judges).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("exits 2 for an invalid judge", async () => {
    const dir = await tmp();
    const err = captureStream(process.stderr);
    const code = await main([
      "configure",
      "--config",
      join(dir, "config.json"),
      "--judge",
      "bogus",
    ]);
    err.restore();
    expect(code).toBe(2);
    expect(err.text()).toContain("invalid judge");
  });

  it("exits 2 instead of clobbering a broken config file", async () => {
    const dir = await tmp();
    const config = join(dir, "config.json");
    await writeFile(config, "not json");
    const err = captureStream(process.stderr);
    const code = await main([
      "configure",
      "--config",
      config,
      "--judge",
      "openai/gpt-4o-mini",
    ]);
    err.restore();
    expect(code).toBe(2);
    expect(err.text()).toContain("not valid JSON");
    expect(await readFile(config, "utf8")).toBe("not json");
  });

  it("stores key=value pairs in the keys file", async () => {
    const dir = await tmp();
    const config = join(dir, "config.json");
    const keys = join(dir, ".env");
    const err = captureStream(process.stderr);
    const code = await main([
      "configure",
      "--config",
      config,
      "--keys-file",
      keys,
      "--set-key",
      "ZAI_API_KEY=zai-secret-123",
    ]);
    err.restore();
    expect(code).toBe(0);
    expect(await readFile(keys, "utf8")).toContain(
      "ZAI_API_KEY=zai-secret-123",
    );
  });

  it("splits --set-key on the first equals only", async () => {
    const dir = await tmp();
    const keys = join(dir, ".env");
    const err = captureStream(process.stderr);
    const code = await main([
      "configure",
      "--keys-file",
      keys,
      "--set-key",
      "CUSTOM_KEY=abc=def",
    ]);
    err.restore();
    expect(code).toBe(0);
    expect(await readFile(keys, "utf8")).toContain("CUSTOM_KEY=abc=def");
  });

  it("exits 2 for an invalid key name", async () => {
    const err = captureStream(process.stderr);
    const code = await main(["configure", "--set-key", "bad-name=x"]);
    err.restore();
    expect(code).toBe(2);
    expect(err.text()).toContain("UPPER_SNAKE_CASE");
  });

  it("exits 2 when --set-key lacks a value without a TTY", async () => {
    const err = captureStream(process.stderr);
    const code = await main(["configure", "--set-key", "OPENAI_API_KEY"]);
    err.restore();
    expect(code).toBe(2);
    expect(err.text()).toContain("needs a value");
  });

  it("removes stored keys with --unset-key", async () => {
    const dir = await tmp();
    const keys = join(dir, ".env");
    await writeFile(keys, "OPENAI_API_KEY=sk-old\nKEEP=1\n");
    const err = captureStream(process.stderr);
    const code = await main([
      "configure",
      "--keys-file",
      keys,
      "--unset-key",
      "OPENAI_API_KEY",
    ]);
    err.restore();
    expect(code).toBe(0);
    const text = await readFile(keys, "utf8");
    expect(text).not.toContain("OPENAI_API_KEY");
    expect(text).toContain("KEEP=1");
  });

  it("--list shows judges and masked key status", async () => {
    const dir = await tmp();
    const config = join(dir, "config.json");
    const keys = join(dir, ".env");
    await writeFile(
      config,
      `${JSON.stringify({ dataset: "canaries", judges: ["laya/router"] })}\n`,
    );
    await writeFile(keys, "OPENAI_API_KEY=sk-1234567890abcd\n");
    const log = captureLog();
    const code = await withEnv("ANTHROPIC_API_KEY", undefined, () =>
      main(["configure", "--config", config, "--keys-file", keys, "--list"]),
    );
    log.restore();
    expect(code).toBe(0);
    const text = log.text();
    expect(text).toContain("laya/router");
    expect(text).toContain(maskSecret("sk-1234567890abcd"));
    expect(text).toContain("ANTHROPIC_API_KEY: missing");
  });

  it("--list --json emits machine-readable state", async () => {
    const dir = await tmp();
    const config = join(dir, "config.json");
    const keys = join(dir, ".env");
    await writeFile(
      config,
      `${JSON.stringify({ dataset: "arena", judges: ["zai/glm-4.7-flashx"] })}\n`,
    );
    await writeFile(keys, "ZAI_API_KEY=zai-secret-123\n");
    const out = captureStream(process.stdout);
    const log = captureLog();
    const code = await main([
      "configure",
      "--config",
      config,
      "--keys-file",
      keys,
      "--list",
      "--json",
    ]);
    log.restore();
    out.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(out.text()) as {
      dataset: string;
      judges: string[];
      keys: { env: string; state: string; value: string | null }[];
    };
    expect(parsed.dataset).toBe("arena");
    expect(parsed.judges).toEqual(["zai/glm-4.7-flashx"]);
    const zai = parsed.keys.find((key) => key.env === "ZAI_API_KEY");
    expect(zai?.state).toBe("file");
    expect(zai?.value).toBe(maskSecret("zai-secret-123"));
  });

  it("exits 2 without flags when stdin is not a TTY", async () => {
    const err = captureStream(process.stderr);
    const code = await main(["configure"]);
    err.restore();
    expect(code).toBe(2);
    expect(err.text()).toContain("interactive terminal");
  });
});

describe("configure wizard", () => {
  it("sets a judge from provider + model suggestions", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await runWizard(
      scriptedPrompts({
        choose: ["model", "openai", "gpt-4o-mini", "__done__"],
      }),
      paths,
    );
    log.restore();
    expect(await readJson(paths.configPath)).toEqual({
      dataset: "canaries",
      judges: ["openai/gpt-4o-mini"],
    });
    expect(log.text()).toContain("--env-file");
  });

  it("adds to or replaces an existing judge list", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await writeFile(
      paths.configPath,
      `${JSON.stringify({ dataset: "canaries", judges: ["openai/gpt-4o-mini"] })}\n`,
    );
    await runWizard(
      scriptedPrompts({
        choose: ["model", "anthropic", "claude-haiku-4-5", "add", "__done__"],
      }),
      paths,
    );
    expect((await readJson(paths.configPath)).judges).toEqual([
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku-4-5",
    ]);
    await runWizard(
      scriptedPrompts({
        choose: [
          "model",
          "anthropic",
          "claude-haiku-4-5",
          "replace",
          "__done__",
        ],
      }),
      paths,
    );
    expect((await readJson(paths.configPath)).judges).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);
    log.restore();
  });

  it("accepts a free-text model via Other… and laya suggestions", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await runWizard(
      scriptedPrompts({
        choose: ["model", "zai", "__other__", "__done__"],
        ask: ["glm-4.7-flashx"],
      }),
      paths,
    );
    expect((await readJson(paths.configPath)).judges).toEqual([
      "zai/glm-4.7-flashx",
    ]);
    await runWizard(
      scriptedPrompts({
        choose: ["model", "laya", "router", "replace", "__done__"],
      }),
      paths,
    );
    expect((await readJson(paths.configPath)).judges).toEqual(["laya/router"]);
    log.restore();
  });

  it("re-prompts when a typed judge is rejected", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await runWizard(
      scriptedPrompts({
        choose: ["model", "laya", "__other__", "laya", "router", "__done__"],
        ask: ["not-a-laya-model"],
      }),
      paths,
    );
    log.restore();
    expect(log.text()).toContain("judge rejected");
    expect((await readJson(paths.configPath)).judges).toEqual(["laya/router"]);
  });

  it("builds a custom provider judge object", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await runWizard(
      scriptedPrompts({
        choose: ["model", "custom", "__done__"],
        ask: ["grok-4", "https://api.x.ai/v1", "XAI_API_KEY"],
      }),
      paths,
    );
    log.restore();
    expect((await readJson(paths.configPath)).judges).toEqual([
      {
        model: "grok-4",
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "XAI_API_KEY",
      },
    ]);
  });

  it("saves an environment-provided key (goose-style)", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await withEnv("ZAI_API_KEY", "zai-env-value-987", async () => {
      await runWizard(
        scriptedPrompts({
          choose: ["keys", "ZAI_API_KEY", "__done__", "__done__"],
          confirm: [true],
        }),
        paths,
      );
    });
    log.restore();
    expect(await readFile(paths.keysFile, "utf8")).toContain(
      "ZAI_API_KEY=zai-env-value-987",
    );
  });

  it("declining the environment save leaves no file", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await withEnv("DEEPSEEK_API_KEY", "deepseek-env", async () => {
      await runWizard(
        scriptedPrompts({
          choose: ["keys", "DEEPSEEK_API_KEY", "__done__", "__done__"],
          confirm: [false],
        }),
        paths,
      );
    });
    log.restore();
    expect(existsSync(paths.keysFile)).toBe(false);
  });

  it("prompts for missing keys and keeps stored ones on decline", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await withEnv("OPENAI_API_KEY", undefined, async () => {
      await runWizard(
        scriptedPrompts({
          choose: ["keys", "OPENAI_API_KEY", "__done__", "__done__"],
          secret: ["sk-typed-987654"],
        }),
        paths,
      );
      await runWizard(
        scriptedPrompts({
          choose: ["keys", "OPENAI_API_KEY", "__done__", "__done__"],
          confirm: [false],
        }),
        paths,
      );
    });
    log.restore();
    expect(log.text()).toContain("already stored");
    expect(await readFile(paths.keysFile, "utf8")).toContain(
      "OPENAI_API_KEY=sk-typed-987654",
    );
  });

  it("updates a stored key when confirmed", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    await writeFile(paths.keysFile, "OPENAI_API_KEY=sk-old-value\n");
    const log = captureLog();
    await withEnv("OPENAI_API_KEY", undefined, async () => {
      await runWizard(
        scriptedPrompts({
          choose: ["keys", "OPENAI_API_KEY", "__done__", "__done__"],
          confirm: [true],
          secret: ["sk-new-value-123"],
        }),
        paths,
      );
    });
    log.restore();
    expect(await readFile(paths.keysFile, "utf8")).toContain(
      "OPENAI_API_KEY=sk-new-value-123",
    );
  });

  it("stores custom env var names, rejecting invalid ones", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await runWizard(
      scriptedPrompts({
        choose: ["keys", "__custom__", "__done__", "__done__"],
        ask: ["nope"],
      }),
      paths,
    );
    await runWizard(
      scriptedPrompts({
        choose: ["keys", "__custom__", "__done__", "__done__"],
        ask: ["XAI_API_KEY"],
        secret: ["xai-secret-1"],
      }),
      paths,
    );
    log.restore();
    expect(log.text()).toContain("not a valid env var name");
    expect(await readFile(paths.keysFile, "utf8")).toContain(
      "XAI_API_KEY=xai-secret-1",
    );
  });

  it("review shows judges, key statuses, and the load hint", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    await writeFile(
      paths.configPath,
      `${JSON.stringify({ dataset: "arena", judges: ["deepseek/deepseek-flash"] })}\n`,
    );
    await writeFile(paths.keysFile, "DEEPSEEK_API_KEY=deepseek-secret-1\n");
    const log = captureLog();
    await runWizard(scriptedPrompts({ choose: ["review", "__done__"] }), paths);
    log.restore();
    const text = log.text();
    expect(text).toContain("deepseek/deepseek-flash");
    expect(text).toContain(maskSecret("deepseek-secret-1"));
    expect(text).toContain("OPENAI_API_KEY: missing");
    expect(text).toContain("next: judgebench --env-file");
  });

  it("reads back what it wrote through the loadEnvFile parser", async () => {
    const dir = await tmp();
    const paths = {
      configPath: join(dir, "config.json"),
      keysFile: join(dir, ".env"),
    };
    const log = captureLog();
    await withEnv("OPENAI_API_KEY", undefined, async () => {
      await runWizard(
        scriptedPrompts({
          choose: ["keys", "OPENAI_API_KEY", "__done__", "__done__"],
          secret: ["sk-roundtrip-42"],
        }),
        paths,
      );
    });
    log.restore();
    const text = await readEnvFile(paths.keysFile);
    expect(text).not.toBeNull();
    expect(parseEnvText(text ?? "")).toContainEqual({
      key: "OPENAI_API_KEY",
      value: "sk-roundtrip-42",
    });
  });
});
