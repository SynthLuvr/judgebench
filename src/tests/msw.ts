import { HttpResponse, http } from "msw";
import { type SetupServer, setupServer } from "msw/node";

import { hash01 } from "../core/rng.ts";

// Copied pattern from system-one-adapter's src/tests/msw.ts (unpublished —
// the adapter's interceptor module is not importable, so judgebench keeps
// its own copy; the small duplication is accepted by design).
//
// Handlers script realistic OpenAI/Anthropic HTTP responses so the whole
// pipeline runs offline: the vitest suite needs no network and no keys.
// Unhandled requests are rejected, so unintended traffic fails loudly.

type JsonRecord = Record<string, unknown>;

const SCHEMA_MARKER =
  "Return one JSON object that matches this schema exactly:";

/** Extract the embedded output schema the adapter adds in prompted mode. */
const schemaFromText = (text: string): JsonRecord | null => {
  const start = text.indexOf(SCHEMA_MARKER);
  if (start === -1) return null;
  const braceStart = text.indexOf("{", start);
  if (braceStart === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = braceStart; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0)
        try {
          return JSON.parse(text.slice(braceStart, index + 1)) as JsonRecord;
        } catch {
          return null;
        }
    }
  }
  return null;
};

/** Coerce an unknown JSON value to display text without object stringification. */
const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value) ?? "";
};

const messagesText = (messages: unknown): string => {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) =>
      typeof message === "object" && message !== null && "content" in message
        ? asText((message as { content: unknown }).content)
        : "",
    )
    .join("\n");
};

/** Pull the JSON schema out of any provider's request body. */
const extractSchema = (body: JsonRecord): JsonRecord | null => {
  const responseFormat = body.response_format as JsonRecord | undefined;
  const jsonSchema = responseFormat?.json_schema as JsonRecord | undefined;
  if (jsonSchema?.schema !== undefined) return jsonSchema.schema as JsonRecord;
  const text = body.text as JsonRecord | undefined;
  const format = text?.format as JsonRecord | undefined;
  if (format?.schema !== undefined) return format.schema as JsonRecord;
  const outputConfig = body.output_config as JsonRecord | undefined;
  const outputFormat = outputConfig?.format as JsonRecord | undefined;
  if (outputFormat?.schema !== undefined)
    return outputFormat.schema as JsonRecord;
  return schemaFromText(
    messagesText(body.messages) +
      asText(body.system) +
      messagesText(body.input),
  );
};

const resolveRef = (schema: JsonRecord, prop: JsonRecord): JsonRecord => {
  const ref = prop.$ref;
  if (typeof ref !== "string") return prop;
  const name = ref.split("/").pop() ?? "";
  const defs = schema.$defs as Record<string, JsonRecord> | undefined;
  const def = defs?.[name];
  return def === undefined ? prop : def;
};

/** Build a valid `{"answers": {...}}` payload for the requested schema. */
const synthesize = (schema: JsonRecord, seedText: string): JsonRecord => {
  const root = resolveRef(
    schema,
    (((schema.properties ?? {}) as JsonRecord).answers as JsonRecord) ?? {},
  );
  const props = (root.properties ?? {}) as Record<string, JsonRecord>;
  const answers: JsonRecord = {};
  for (const [question, rawProp] of Object.entries(props)) {
    const prop = resolveRef(schema, rawProp);
    const roll = hash01(`${seedText}:${question}`);
    if (prop.properties !== undefined) {
      const labels = Object.keys(prop.properties as JsonRecord);
      // Deterministic peaked distribution; the favored label rotates with
      // the seed so AB/BA orders disagree on a slice of samples (flips).
      const favorite = labels[Math.floor(roll * labels.length)] ?? labels[0];
      const peak = 0.55 + 0.35 * roll;
      const rest = (1 - peak) / Math.max(labels.length - 1, 1);
      const distribution: JsonRecord = {};
      for (const label of labels)
        distribution[label] =
          label === favorite
            ? Number(peak.toFixed(4))
            : Number(rest.toFixed(4));
      answers[question] = distribution;
    } else if (Array.isArray(prop.enum)) {
      const values = prop.enum as string[];
      answers[question] = values[Math.floor(roll * values.length)] ?? values[0];
    } else if (prop.type === "boolean") answers[question] = roll > 0.35;
    else answers[question] = Number((0.15 + 0.7 * roll).toFixed(3));
  }
  return { answers };
};

/** Deterministic-looking token accounting tied to the request. */
const usageFor = (seedText: string, outputText: string): JsonRecord => {
  const inputTokens = 700 + Math.floor(hash01(`in:${seedText}`) * 500);
  const outputTokens =
    12 + Math.floor(hash01(`out:${seedText}`) * 40 + outputText.length / 60);
  return { input_tokens: inputTokens, output_tokens: outputTokens };
};

type MswControl = {
  readonly server: SetupServer;
  readonly close: () => void;
  /** Queue n malformed OpenAI chat responses to exercise corrective retries. */
  readonly queueMalformed: (n: number) => void;
  /** Every intercepted request, for assertions. */
  readonly calls: { url: string; body: unknown }[];
};

const MTBENCH_ROW = {
  question_id: 81,
  model_a: "alpaca-13b",
  model_b: "gpt-3.5-turbo",
  winner: "model_b",
  judge: "author",
  turn: 1,
  conversation_a: [
    { role: "user", content: "Write a haiku about rain." },
    { role: "assistant", content: "Rain falls on the roof" },
  ],
  conversation_b: [
    { role: "user", content: "Write a haiku about rain." },
    { role: "assistant", content: "Soft rain at midnight" },
  ],
};

const ARENA_ROW = {
  id: 4242,
  model_a: "model-x",
  model_b: "model-y",
  prompt: ["What is 2+2?"],
  response_a: ["2 + 2 equals 4."],
  response_b: ["Four."],
  winner_model_a: 0,
  winner_model_b: 1,
  winner_tie: 0,
};

/** Start the offline interceptor covering OpenAI and Anthropic wire formats. */
const startJudgebenchMsw = (): MswControl => {
  const calls: { url: string; body: unknown }[] = [];
  let malformedQueue = 0;

  const openaiResponses = http.post("*/v1/responses", async ({ request }) => {
    const body = (await request.json()) as JsonRecord;
    calls.push({ url: request.url, body });
    const seedText = messagesText(body.input) + asText(body.instructions);
    if (malformedQueue > 0) {
      malformedQueue -= 1;
      return HttpResponse.json({
        id: "resp_msw",
        object: "response",
        status: "completed",
        model: asText(body.model) || "msw-model",
        output: [],
        output_text: "not json",
        usage: { input_tokens: 10, output_tokens: 3 },
      });
    }
    const schema = extractSchema(body) ?? {};
    const payload = JSON.stringify(synthesize(schema, seedText));
    const usage = usageFor(seedText, payload);
    return HttpResponse.json({
      id: "resp_msw",
      object: "response",
      status: "completed",
      model: asText(body.model) || "msw-model",
      output: [
        {
          type: "message",
          id: "msg_msw",
          role: "assistant",
          content: [{ type: "output_text", text: payload }],
        },
      ],
      output_text: payload,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    });
  });

  const openaiChat = http.post("*/v1/chat/completions", async ({ request }) => {
    const body = (await request.json()) as JsonRecord;
    calls.push({ url: request.url, body });
    const seedText = messagesText(body.messages);
    if (malformedQueue > 0) {
      malformedQueue -= 1;
      return HttpResponse.json({
        id: "chatcmpl_msw",
        object: "chat.completion",
        created: 1_700_000_000,
        model: asText(body.model) || "msw-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "definitely not json" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
      });
    }
    const schema = extractSchema(body) ?? {};
    const payload = JSON.stringify(synthesize(schema, seedText));
    const usage = usageFor(seedText, payload);
    return HttpResponse.json({
      id: "chatcmpl_msw",
      object: "chat.completion",
      created: 1_700_000_000,
      model: asText(body.model) || "msw-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: payload },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens:
          (usage.input_tokens as number) + (usage.output_tokens as number),
      },
    });
  });

  const anthropicMessages = http.post("*/v1/messages", async ({ request }) => {
    const body = (await request.json()) as JsonRecord;
    calls.push({ url: request.url, body });
    const seedText = messagesText(body.messages) + asText(body.system);
    const schema = extractSchema(body) ?? {};
    const payload = JSON.stringify(synthesize(schema, seedText));
    const usage = usageFor(seedText, payload);
    return HttpResponse.json({
      id: "msg_msw",
      type: "message",
      role: "assistant",
      model: asText(body.model) || "msw-model",
      content: [{ type: "text", text: payload }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    });
  });

  // HuggingFace dataset endpoints, so `fetch` runs offline in tests too.
  const mtbenchRows = http.get("*/rows*", ({ request }) => {
    const url = new URL(request.url);
    const dataset = url.searchParams.get("dataset") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const length = Number(url.searchParams.get("length") ?? "100");
    const row =
      dataset === "lmsys/mt_bench_human_judgments" ? MTBENCH_ROW : ARENA_ROW;
    const rows = Array.from({ length }, (_, index) => {
      const base =
        row === MTBENCH_ROW
          ? {
              ...row,
              winner: ["model_a", "model_b", "tie"][index % 3],
              question_id: 81 + (Math.floor((offset + index) / 3) % 3),
            }
          : row;
      const withId = base as typeof base & { id?: number };
      return {
        row:
          withId.id === undefined
            ? base
            : { ...base, id: withId.id + offset + index },
      };
    });
    return HttpResponse.json({ rows: offset >= 3 * length ? [] : rows });
  });

  const hfDatasetInfo = http.get("https://huggingface.co/api/datasets/*", () =>
    HttpResponse.json({ cardData: { license: "cc-by-4.0" }, siblings: [] }),
  );

  const server = setupServer(
    openaiResponses,
    openaiChat,
    anthropicMessages,
    mtbenchRows,
    hfDatasetInfo,
  );
  server.listen({ onUnhandledRequest: "error" });
  return {
    server,
    close: () => server.close(),
    queueMalformed: (n: number) => {
      malformedQueue += n;
    },
    calls,
  };
};

export type { MswControl };
export { extractSchema, startJudgebenchMsw, synthesize };
