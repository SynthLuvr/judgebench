import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

// Copied pattern from system-one-adapter's src/tests/msw.ts (unpublished —
// the adapter's interceptor module is not importable, so judgebench keeps
// its own copy; the small duplication is accepted by design).
// TODO Phase 0: script realistic OpenAI/Anthropic chat responses so the
// whole pipeline runs offline in `judgebench smoke` and CI.

const openaiChat = http.post("https://api.openai.com/v1/chat/completions", () =>
  HttpResponse.json({}),
);

const anthropicMessages = http.post(
  "https://api.anthropic.com/v1/messages",
  () => HttpResponse.json({}),
);

const mswServer = setupServer(openaiChat, anthropicMessages);

export { mswServer };
