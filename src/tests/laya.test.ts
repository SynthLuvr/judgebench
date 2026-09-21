import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choice, noul, SystemOneAdapterClient } from "system-one-adapter";
import { beforeAll, describe, expect, it } from "vitest";

import {
  defaultRunner,
  LAYA_SCRIPT,
  LayaProvider,
  questionsFromSchema,
  stateFromMessages,
} from "../core/laya.ts";

type Payload = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<
    string,
    {
      kind: string;
      laya: {
        type: string;
        instructions: string;
        criteria?: Record<string, string>;
      };
    }
  >;
};

/** Fake runner standing in for python + laya, mirroring the embedded script. */
const fakeRunner = async (
  python: string,
  script: string,
  stdin: string,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  expect(python).toBe("python3");
  expect(script).toBe(LAYA_SCRIPT);
  const payload = JSON.parse(stdin) as Payload;
  const answers: Record<string, unknown> = {};
  for (const [questionId, spec] of Object.entries(payload.questions))
    if (spec.kind === "probabilityMap") {
      const labels = Object.keys(spec.laya.criteria ?? {});
      answers[questionId] = Object.fromEntries(
        labels.map((label, index) => [
          label,
          index === 0 ? 0.6 : 0.4 / Math.max(labels.length - 1, 1),
        ]),
      );
    } else if (spec.kind === "probability") answers[questionId] = 0.83;
    else if (spec.kind === "boolean") answers[questionId] = true;
    else answers[questionId] = Object.keys(spec.laya.criteria ?? {})[0];

  return { stdout: JSON.stringify({ answers }), stderr: "", code: 0 };
};

const failingRunner = async (): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> => ({
  stdout: "",
  stderr: "ModuleNotFoundError: No module named 'laya'",
  code: 1,
});

const provider = (runPython = fakeRunner) =>
  new LayaProvider("router", { runPython });

const client = (runPython = fakeRunner) =>
  new SystemOneAdapterClient({
    structuredOutputs: true,
    llmAnswerMode: "probabilities",
    normalizeProbabilities: true,
    model: provider(runPython),
  });

const questions = {
  verdict: choice("Which response is better?", {
    A: "Assistant 1 is better",
    B: "Assistant 2 is better",
    tie: "Equally good",
  }),
  is_safe: noul("Is the exchange safe?"),
};

describe("LayaProvider", () => {
  it("evaluates typed questions through the python bridge", async () => {
    const received: Payload[] = [];
    const spyRunner = async (
      python: string,
      script: string,
      stdin: string,
    ): Promise<{ stdout: string; stderr: string; code: number }> => {
      received.push(JSON.parse(stdin) as Payload);
      return fakeRunner(python, script, stdin);
    };
    const adapter = client(spyRunner);
    const response = await adapter.systemOne({
      state: { user_message: "hi", assistant_1: "a", assistant_2: "b" },
      questions,
    });
    await adapter.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.model).toBe("router");
    expect(received[0]?.state.user_message).toBe("hi");
    const verdict = received[0]?.questions.verdict?.laya;
    expect(verdict?.type).toBe("choice");
    expect(Object.keys(verdict?.criteria ?? {})).toEqual(["A", "B", "tie"]);
    expect(received[0]?.questions.is_safe?.laya.type).toBe("noul");

    const answer = response.choices.verdict;
    expect(answer.probabilities?.A).toBeCloseTo(0.6, 5);
    expect(answer.choice).toBe("A");
    expect(response.model).toBe("laya/router");
    expect(response.usage.input_tokens_total).toBe(0);
    expect(response.nouls.is_safe.noul).toBeCloseTo(0.83, 5);
  });

  it("maps discrete answers (enum labels, boolean nouls)", async () => {
    const adapter = new SystemOneAdapterClient({
      structuredOutputs: false,
      llmAnswerMode: "discrete",
      model: provider(),
    });
    const response = await adapter.systemOne({
      state: { body: "text" },
      questions,
    });
    await adapter.close();
    expect(response.choices.verdict.choice).toBe("A");
    expect(response.nouls.is_safe.noul).toBe(1);
  });

  it("surfaces python failures as provider errors", async () => {
    const adapter = client(failingRunner);
    await expect(
      adapter.systemOne({ state: { body: "x" }, questions }),
    ).rejects.toThrow(/laya python process exited 1.*laya/u);
    await adapter.close();
  });

  it("rejects score questions the bridge cannot express", () => {
    expect(() =>
      questionsFromSchema({
        $defs: {
          TypeSafeAnswers: {
            properties: { rating: { type: "integer", description: "level" } },
          },
        },
        properties: {
          answers: { $ref: "#/$defs/TypeSafeAnswers" },
        },
      }),
    ).toThrow(/score questions/u);
  });

  it("extracts the document state from provider messages", () => {
    const state = stateFromMessages([
      { role: "system", content: "instructions" },
      {
        role: "user",
        content: '<document>\n{"body": "hello"}\n</document>',
      },
    ]);
    expect(state).toEqual({ body: "hello" });
    expect(
      stateFromMessages([{ role: "user", content: "no document here" }]),
    ).toBeNull();
  });

  it("rejects requests whose state or schema cannot be recovered", async () => {
    const laya = provider();
    await expect(
      laya.request([{ role: "user", content: "no document" }], {
        schema: { properties: {} },
        structured: true,
      }),
    ).rejects.toThrow(/could not recover/u);
  });

  it("rejects python output that is not JSON", async () => {
    const laya = provider(async () => ({
      stdout: "not json",
      stderr: "",
      code: 0,
    }));
    await expect(
      laya.request(
        [
          {
            role: "user",
            content: '<document>\n{"body": "x"}\n</document>',
          },
        ],
        {
          schema: {
            $defs: {
              TypeSafeAnswers: {
                properties: {
                  q: { type: "number", description: "any" },
                },
              },
            },
            properties: { answers: { $ref: "#/$defs/TypeSafeAnswers" } },
          },
          structured: false,
        },
      ),
    ).rejects.toThrow(/invalid JSON/u);
  });

  it("maps foreign errors to SDK errors", () => {
    const laya = provider();
    expect(laya.translateError(new Error("boom")).message).toBe("boom");
    expect(laya.translateError("raw").message).toBe("raw");
  });

  it("reports spawn failures through the default runner", async () => {
    const result = await defaultRunner(
      "judgebench-no-such-python",
      LAYA_SCRIPT,
      "{}",
    );
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("judgebench-no-such-python");
  });
});

/** The stub `laya` module the embedded script is exercised against. */
const LAYA_STUB = `
class _Agent:
    def predict(self, state, questions):
        answers = {}
        for qid, q in questions.items():
            if q["type"] == "choice":
                labels = list(q["criteria"].keys())
                probs = {}
                for i, label in enumerate(labels):
                    probs[label] = 0.6 if i == 0 else 0.4 / max(len(labels) - 1, 1)
                answers[qid] = {"type": "choice", "choice": labels[0],
                                "confidence": 0.6, "probabilities": probs}
            else:
                answers[qid] = {"type": "noul", "noul": 0.83}
        return {"answers": answers}

class Router:
    def __init__(self, **kwargs):
        pass

    def predict(self, state, questions):
        return _Agent().predict(state, questions)

def load(repo, subfolder=None):
    return _Agent()
`;

describe("embedded python script", () => {
  let pythonAvailable = false;

  beforeAll(async () => {
    pythonAvailable = await new Promise((resolve) => {
      const child = spawn("python3", ["-c", "pass"]);
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(true));
    });
  });

  it("runs the real script against a stubbed laya package", async () => {
    if (!pythonAvailable) return;
    const dir = await mkdtemp(join(tmpdir(), "judgebench-laya-"));
    const previousPath = process.env.PYTHONPATH;
    try {
      await writeFile(join(dir, "laya.py"), LAYA_STUB, "utf8");
      process.env.PYTHONPATH = dir;
      const stdin = JSON.stringify({
        model: "router",
        state: { body: "duplicate charge" },
        questions: {
          verdict: {
            kind: "probabilityMap",
            laya: {
              type: "choice",
              instructions: "Which is better?",
              criteria: { A: "first", B: "second", tie: "equal" },
            },
          },
          urgent: {
            kind: "probability",
            laya: { type: "noul", instructions: "Urgent?" },
          },
        },
      });
      const result = await defaultRunner("python3", LAYA_SCRIPT, stdin);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        answers: Record<string, unknown>;
      };
      expect(parsed.answers.verdict).toEqual({
        A: 0.6,
        B: 0.2,
        tie: 0.2,
      });
      expect(parsed.answers.urgent).toBe(0.83);
    } finally {
      if (previousPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
