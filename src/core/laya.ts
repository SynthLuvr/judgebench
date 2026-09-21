import { spawn } from "node:child_process";

import {
  type Message,
  type Provider,
  type ProviderRequestOptions,
  TypeSafeError,
} from "system-one-adapter";

/** One laya checkpoint to run locally (github.com/NandhaKishorM/laya). */
type LayaOptions = {
  /** Python interpreter hosting the laya package; default `python3`. */
  readonly python?: string;
  /** Runs the one-shot python process; injectable for offline tests. */
  readonly runPython?: PythonRunner;
};

/** Result of one python one-shot invocation. */
type PythonResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

type PythonRunner = (
  python: string,
  script: string,
  stdin: string,
) => Promise<PythonResult>;

/** How the adapter expects each question answered, from its JSON schema. */
type AnswerKind = "probabilityMap" | "probability" | "boolean" | "enum";

type ReconstructedQuestion = {
  readonly kind: AnswerKind;
  readonly laya: {
    type: "choice" | "noul";
    instructions: string;
    criteria?: Record<string, string>;
  };
};

type JsonRecord = Record<string, unknown>;

const DOCUMENT_START = "<document>\n";
const DOCUMENT_END = "\n</document>";

/**
 * One-shot python script: read {model, state, questions} from stdin, run
 * the laya engine, print adapter-shaped answers to stdout. laya answers
 * typed questions natively (choice probabilities, noul probabilities), so
 * no text generation is involved.
 */
const LAYA_SCRIPT = `
import json, sys

payload = json.load(sys.stdin)
model = payload["model"]
state = payload["state"]
specs = payload["questions"]
questions = {qid: spec["laya"] for qid, spec in specs.items()}

if model == "router":
    from laya import Router
    result = Router().predict(state, questions)
else:
    import laya
    subfolder = {"english": None, "multilingual": "multilingual",
                 "typed-decisions": "typed-decisions"}[model]
    if subfolder is None:
        agent = laya.load("convaiinnovations/laya")
    else:
        agent = laya.load("convaiinnovations/laya", subfolder=subfolder)
    result = agent.predict(state, questions)

answers = {}
for qid, spec in specs.items():
    answer = result["answers"][qid]
    kind = spec["kind"]
    if kind == "probabilityMap":
        answers[qid] = answer.get("probabilities", {})
    elif kind == "probability":
        answers[qid] = float(answer.get("noul", 0.0))
    elif kind == "boolean":
        answers[qid] = float(answer.get("noul", 0.0)) >= 0.5
    else:
        answers[qid] = answer.get("choice")
print(json.dumps({"answers": answers}))
`;

const defaultRunner: PythonRunner = (python, script, stdin) =>
  new Promise((resolve) => {
    const child = spawn(python, ["-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      resolve({
        stdout: "",
        stderr: `${error.message}\n${stderr}`,
        code: -1,
      }),
    );
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin, "utf8");
  });

/** Extract the adapter's `<document>` state JSON from the user message. */
const stateFromMessages = (messages: readonly Message[]): JsonRecord | null => {
  const userMessages = messages.filter((message) => message.role === "user");
  const last = userMessages[userMessages.length - 1];
  if (last === undefined) return null;
  const start = last.content.indexOf(DOCUMENT_START);
  const end = last.content.lastIndexOf(DOCUMENT_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const raw = last.content.slice(start + DOCUMENT_START.length, end);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
};

const recordOf = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const descriptionOf = (property: JsonRecord): string => {
  const description = property.description;
  if (typeof description === "string") return description;
  if (description === undefined || description === null) return "";
  return JSON.stringify(description) ?? "";
};

const asCriteria = (value: unknown): Record<string, string> | null => {
  const record = recordOf(value);
  if (record === null) return null;
  const criteria: Record<string, string> = {};
  for (const [label, property] of Object.entries(record)) {
    const prop = recordOf(property);
    if (prop === null) return null;
    criteria[label] = descriptionOf(prop);
  }
  return criteria;
};

/** Parse `label = description` lines a discrete-mode schema embeds. */
const criteriaFromDescription = (
  description: string,
): Record<string, string> => {
  const criteria: Record<string, string> = {};
  for (const line of description.split("\n")) {
    const match = /^(\S+)\s*=\s*(.+)$/.exec(line.trim());
    if (match !== null) criteria[match[1]] = match[2];
  }
  return criteria;
};

/**
 * Reconstruct laya questions from the adapter's JSON schema: every
 * probability-map property is a choice question, boolean/number properties
 * are noul questions. Score (integer) answers are not supported.
 */
const questionsFromSchema = (
  schema: JsonRecord,
): Record<string, ReconstructedQuestion> | null => {
  const defs = recordOf(schema.$defs);
  const answersRef = recordOf(recordOf(schema.properties)?.answers);
  const answersRefValue = answersRef?.$ref;
  if (typeof answersRefValue !== "string" || defs === null) return null;
  const answersName = answersRefValue.split("/").pop();
  if (answersName === undefined) return null;
  const answersDef = recordOf(defs[answersName]);
  const questionProps = recordOf(answersDef?.properties);
  if (questionProps === null) return null;
  const questions: Record<string, ReconstructedQuestion> = {};
  for (const [questionId, rawProperty] of Object.entries(questionProps)) {
    const property = recordOf(rawProperty);
    if (property === null) return null;
    const ref = property.$ref;
    if (typeof ref === "string") {
      const refName = ref.split("/").pop();
      const mapDef = refName === undefined ? null : recordOf(defs[refName]);
      const criteria = asCriteria(mapDef?.properties);
      if (criteria === null) return null;
      questions[questionId] = {
        kind: "probabilityMap",
        laya: {
          type: "choice",
          instructions: descriptionOf(mapDef ?? {}),
          criteria,
        },
      };
      continue;
    }
    const description = descriptionOf(property);
    if (Array.isArray(property.enum)) {
      const criteria = criteriaFromDescription(description);
      questions[questionId] = {
        kind: "enum",
        laya: {
          type: "choice",
          instructions: description.split("\nChoice labels")[0],
          criteria,
        },
      };
      continue;
    }
    if (property.type === "integer")
      throw new TypeSafeError(
        `laya judge does not support score questions (question ${questionId})`,
      );
    questions[questionId] = {
      kind: property.type === "boolean" ? "boolean" : "probability",
      laya: {
        type: "noul",
        instructions: description.split("\nTrue criteria")[0],
      },
    };
  }
  return questions;
};

/**
 * Provider running the local laya decision engine through a one-shot
 * python process per request. Implements the adapter's Provider surface,
 * so SystemOneAdapterClient consumes it like any other provider.
 */
class LayaProvider implements Provider {
  readonly modelName: string;
  readonly #model: string;
  readonly #python: string;
  readonly #runner: PythonRunner;

  constructor(model: string, options: LayaOptions = {}) {
    this.modelName = `laya/${model}`;
    this.#model = model;
    this.#python = options.python ?? process.env.LAYA_PYTHON ?? "python3";
    this.#runner = options.runPython ?? defaultRunner;
  }

  /** No-op: each request spawns a fresh short-lived process. */
  close(): void {
    // Nothing to release; python processes exit with each request.
  }

  /** Run one evaluation through the local laya package. */
  async request(
    messages: readonly Message[],
    options: ProviderRequestOptions,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const state = stateFromMessages(messages);
    const schema = recordOf(options.schema);
    const questions =
      state === null || schema === null ? null : questionsFromSchema(schema);
    if (questions === null)
      throw new TypeSafeError(
        "laya provider could not recover state and questions from the request",
      );
    const payload = JSON.stringify({
      model: this.#model,
      state,
      questions,
    });
    const result = await this.#runner(this.#python, LAYA_SCRIPT, payload);
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").slice(-4).join(" | ");
      throw new TypeSafeError(
        `laya python process exited ${result.code}: ${detail}`,
      );
    }
    try {
      JSON.parse(result.stdout);
    } catch (error) {
      throw new TypeSafeError(
        `laya python process printed invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A local encoder has no token metering; costs stay excluded and only
    // latency (measured by the adapter) is reported.
    return { text: result.stdout, inputTokens: 0, outputTokens: 0 };
  }

  /** Map a laya process failure to an SDK error. */
  translateError(error: unknown): TypeSafeError {
    if (error instanceof TypeSafeError) return error;
    return new TypeSafeError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export type {
  AnswerKind,
  LayaOptions,
  PythonResult,
  PythonRunner,
  ReconstructedQuestion,
};
export {
  defaultRunner,
  LAYA_SCRIPT,
  LayaProvider,
  questionsFromSchema,
  stateFromMessages,
};
