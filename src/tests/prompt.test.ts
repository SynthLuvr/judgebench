import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { promptsOn } from "../io/prompt.ts";

/** Type one line after the pending question is guaranteed registered,
 * then let the prompt's control flow settle before the next line. */
const type = (input: PassThrough, line: string): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(() => {
      input.write(`${line}\n`);
      setImmediate(resolve);
    });
  });

const harness = (): {
  prompts: ReturnType<typeof promptsOn>;
  input: PassThrough;
  output: string[];
} => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { prompts: promptsOn(input, output), input, output: chunks };
};

describe("prompts", () => {
  it("choose returns the numbered selection", async () => {
    const { prompts, input } = harness();
    const answer = prompts.choose("pick", [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
    await type(input, "2");
    expect(await answer).toBe("b");
  });

  it("choose retries on an out-of-range number", async () => {
    const { prompts, input, output } = harness();
    const answer = prompts.choose("pick", [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
    await type(input, "9");
    await type(input, "1");
    expect(await answer).toBe("a");
    expect(output.join("")).toContain("pick a number between 1 and 2");
  });

  it("choose renders hints", async () => {
    const { prompts, input, output } = harness();
    const answer = prompts.choose("pick", [
      { value: "a", label: "Alpha", hint: "first letter" },
    ]);
    await type(input, "1");
    expect(await answer).toBe("a");
    expect(output.join("")).toContain("first letter");
  });

  it("ask returns typed input", async () => {
    const { prompts, input } = harness();
    const answer = prompts.ask("name");
    await type(input, "glm-4.7-flashx");
    expect(await answer).toBe("glm-4.7-flashx");
  });

  it("ask falls back to the default on empty input", async () => {
    const { prompts, input } = harness();
    const answer = prompts.ask("name", { default: "router" });
    await type(input, "");
    expect(await answer).toBe("router");
  });

  it("ask accepts empty optional input but retries required input", async () => {
    const { prompts, input, output } = harness();
    const optional = prompts.ask("note", { optional: true });
    await type(input, "");
    expect(await optional).toBe("");
    const required = prompts.ask("name");
    await type(input, "");
    await type(input, "ok");
    expect(await required).toBe("ok");
    expect(output.join("")).toContain("a value is required");
  });

  it("confirm maps y/n/empty to booleans", async () => {
    const { prompts, input } = harness();
    const yes = prompts.confirm("proceed");
    await type(input, "y");
    expect(await yes).toBe(true);
    const no = prompts.confirm("proceed", true);
    await type(input, "n");
    expect(await no).toBe(false);
    const emptyDefault = prompts.confirm("proceed", false);
    await type(input, "");
    expect(await emptyDefault).toBe(false);
  });

  it("secret never echoes the typed value", async () => {
    const { prompts, input, output } = harness();
    const answer = prompts.secret("API key");
    await type(input, "sk-super-secret");
    expect(await answer).toBe("sk-super-secret");
    const rendered = output.join("");
    expect(rendered).toContain("API key");
    expect(rendered).not.toContain("sk-super-secret");
    expect(rendered).toContain("********");
    prompts.close();
  });

  it("keeps pasted lines queued across prompts", async () => {
    const { prompts, input } = harness();
    const first = prompts.choose("pick", [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
    const second = prompts.ask("name");
    // Both answers arrive in one burst, before the second prompt renders.
    input.write("2\ntyped-ahead\n");
    expect(await first).toBe("b");
    expect(await second).toBe("typed-ahead");
    prompts.close();
  });

  it("rejects a pending prompt when the input closes (Ctrl+D)", async () => {
    const { prompts, input } = harness();
    const answer = prompts.ask("name");
    input.end();
    await expect(answer).rejects.toThrow("closed before an answer");
  });
});
