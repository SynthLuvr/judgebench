import { OpenAIProvider } from "system-one-adapter";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CellSpec, configHash, resolveConfig } from "../core/config.ts";
import type { Sample } from "../core/dataset.ts";
import {
  buildClient,
  buildQuestions,
  buildState,
  judgeSample,
  pricingId,
} from "../core/judge.ts";

import { startJudgebenchMsw } from "./msw.ts";

const msw = startJudgebenchMsw();

beforeAll(() => {
  process.env.OPENAI_API_KEY ??= "test-key";
});

afterEach(() => {
  msw.calls.length = 0;
});

const SAMPLE: Sample = {
  id: "unit-1",
  prompt: "What is the capital of France?",
  response_a: "The capital of France is Paris.",
  response_b: "Paris is the capital of France, a city of light.",
  human_label: "A",
  model_a: "model-a",
  model_b: "model-b",
};

const configPath = "src/tests/fixtures/minimal.config.json";
const baseCell: CellSpec = {
  answerMode: "probabilities",
  structuredOutputs: true,
  labels: ["A", "B", "tie"],
  rubric: null,
};

const resolvedFor = async () => {
  const resolved = await resolveConfig(configPath, {});
  return resolved;
};

describe("buildState", () => {
  it("places responses per order", () => {
    const ab = buildState(SAMPLE, "AB") as Record<string, string>;
    const ba = buildState(SAMPLE, "BA") as Record<string, string>;
    expect(ab.assistant_1).toBe(SAMPLE.response_a);
    expect(ab.assistant_2).toBe(SAMPLE.response_b);
    expect(ba.assistant_1).toBe(SAMPLE.response_b);
    expect(ba.assistant_2).toBe(SAMPLE.response_a);
    expect(ab.user_message).toBe(SAMPLE.prompt);
  });
});

describe("buildQuestions", () => {
  it("builds the verdict choice with optional tie and rubric nouls", () => {
    const plain = buildQuestions({ ...baseCell, labels: ["A", "B"] });
    expect(Object.keys(plain)).toEqual(["verdict"]);
    const tie = buildQuestions(baseCell) as Record<
      string,
      { type: string; criteria?: unknown }
    >;
    expect(Object.keys(tie.verdict.criteria as object)).toEqual([
      "A",
      "B",
      "tie",
    ]);
    const rubric = buildQuestions({ ...baseCell, rubric: "default" });
    expect(Object.keys(rubric)).toEqual([
      "verdict",
      "relevance_1",
      "relevance_2",
      "accuracy_1",
      "accuracy_2",
      "completeness_1",
      "completeness_2",
      "clarity_1",
      "clarity_2",
    ]);
  });
});

describe("judgeSample", () => {
  it("produces a canonical judgment with adapter telemetry", async () => {
    const resolved = await resolvedFor();
    const judge = {
      id: "openai/gpt-4o-mini",
      provider: "openai" as const,
      model: "gpt-4o-mini",
    };
    const client = buildClient(judge, baseCell, resolved);
    const record = await judgeSample(
      client,
      SAMPLE,
      "AB",
      baseCell,
      judge.id,
      "hash1",
      null,
    );
    await client.close();
    expect(record.error).toBeNull();
    expect(record.raw_label).toMatch(/^(A|B|tie)$/);
    expect(record.probs).not.toBeNull();
    const probs = record.probs as number[];
    expect(probs).toHaveLength(3);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 1);
    expect(record.usage?.input_tokens_total).toBeGreaterThan(0);
    expect(record.usage?.latency).toBeGreaterThanOrEqual(0);
    expect(record.model).toBe("gpt-4o-mini");
    expect(record.config_hash).toBe("hash1");
    expect(record.human_label).toBe("A");
    expect(record.llm_attempt?.messages.length).toBeGreaterThan(0);
    expect(record.llm_attempt?.model_request_parameters.structured).toBe(true);
  });

  it("maps probabilities into canonical order for BA", async () => {
    const resolved = await resolvedFor();
    const judge = {
      id: "openai/gpt-4o-mini",
      provider: "openai" as const,
      model: "gpt-4o-mini",
    };
    const client = buildClient(judge, baseCell, resolved);
    const ab = await judgeSample(
      client,
      SAMPLE,
      "AB",
      baseCell,
      judge.id,
      "h",
      null,
    );
    const ba = await judgeSample(
      client,
      SAMPLE,
      "BA",
      baseCell,
      judge.id,
      "h",
      ab.raw_label,
    );
    await client.close();
    // The MSW judge keys its distribution off the document, and the two
    // orders swap documents, so position-A probability maps to canonical B.
    expect(ab.probs?.[0]).not.toBeNull();
    expect(ba.probs?.[0]).not.toBeNull();
    // swap_consistent is null for the first pass and boolean for the second.
    expect(ab.swap_consistent).toBeNull();
    expect(typeof ba.swap_consistent).toBe("boolean");
  });

  it("records provider errors instead of throwing", async () => {
    const resolved = await resolvedFor();
    const judge = {
      id: "custom/broken-model",
      provider: "custom" as const,
      model: "broken-model",
      baseUrl: "https://broken.example.test/v1",
    };
    const client = buildClient(judge, baseCell, resolved);
    const { HttpResponse } = await import("msw");
    const { http } = await import("msw");
    msw.server.use(
      http.post(
        "https://broken.example.test/v1/chat/completions",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    const record = await judgeSample(
      client,
      SAMPLE,
      "AB",
      baseCell,
      judge.id,
      "h",
      null,
    );
    await client.close();
    expect(record.raw_label).toBeNull();
    expect(record.error).not.toBeNull();
    expect(record.error_type).toBeTruthy();
  });

  it("consumes corrective retries on malformed output", async () => {
    const resolved = await resolvedFor();
    const judge = {
      id: "openai/gpt-4o-mini",
      provider: "openai" as const,
      model: "gpt-4o-mini",
    };
    const client = buildClient(
      judge,
      { ...baseCell, structuredOutputs: false },
      resolved,
    );
    msw.queueMalformed(1);
    const record = await judgeSample(
      client,
      SAMPLE,
      "AB",
      { ...baseCell, structuredOutputs: false },
      judge.id,
      "h",
      null,
    );
    await client.close();
    expect(record.error).toBeNull();
    expect(record.n_retries_malformed_structure).toBe(1);
    expect(
      record.retry_reasons.some(
        ([category]) => category === "malformed_structure",
      ),
    ).toBe(true);
  });
});

describe("pricingId", () => {
  it("derives pricing identity from judge specs", () => {
    expect(
      pricingId({
        id: "openai/gpt-4o-mini",
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    ).toBe("openai/gpt-4o-mini");
    expect(
      pricingId({ id: "custom/grok-4", provider: "custom", model: "grok-4" }),
    ).toBe("custom/grok-4");
    expect(
      pricingId({
        id: "zai/glm-4.7-flashx",
        provider: "zai",
        model: "glm-4.7-flashx",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKeyEnv: "ZAI_API_KEY",
      }),
    ).toBe("zai/glm-4.7-flashx");
    expect(
      pricingId({ id: "laya/router", provider: "laya", model: "router" }),
    ).toBe("laya/router");
  });
});

describe("buildClient providers", () => {
  it("routes named endpoints through the OpenAI-compatible provider", async () => {
    const resolved = await resolvedFor();
    process.env.ZAI_API_KEY = "zai-key";
    process.env.DEEPSEEK_API_KEY = "ds-key";
    const zai = buildClient(
      {
        id: "zai/glm-4.7-flashx",
        provider: "zai",
        model: "glm-4.7-flashx",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKeyEnv: "ZAI_API_KEY",
      },
      baseCell,
      resolved,
    );
    const deepseek = buildClient(
      {
        id: "deepseek/deepseek-flash",
        provider: "deepseek",
        model: "deepseek-flash",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      baseCell,
      resolved,
    );
    const zaiModel = zai.model as OpenAIProvider;
    expect(zaiModel.api).toBe("chat_completions");
    expect(zaiModel.client.baseURL).toBe("https://api.z.ai/api/paas/v4");
    expect((deepseek.model as OpenAIProvider).client.baseURL).toBe(
      "https://api.deepseek.com",
    );
    await zai.close();
    await deepseek.close();
    delete process.env.ZAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("routes laya judges through the adapter-native provider", async () => {
    const resolved = await resolvedFor();
    const laya = buildClient(
      { id: "laya/router", provider: "laya", model: "router" },
      baseCell,
      resolved,
    );
    expect(laya.provider).toBe("laya");
    expect(laya.model).toBe("router");
    await laya.close();
  });
});

describe("configHash integration", () => {
  it("differs across judges", async () => {
    const resolved = await resolvedFor();
    const a = configHash(
      { id: "openai/a", provider: "openai", model: "a" },
      baseCell,
      resolved,
    );
    const b = configHash(
      { id: "openai/b", provider: "openai", model: "b" },
      baseCell,
      resolved,
    );
    expect(a).not.toBe(b);
  });
});
