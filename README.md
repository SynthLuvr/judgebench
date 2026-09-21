# judgebench

A standalone LLM-as-judge benchmark CLI: `judgebench` judges pairs of
model responses against human preference labels through
[`system-one-adapter`](https://www.npmjs.com/package/system-one-adapter)
and reports agreement, position bias, calibration, cost, and
reliability.

``` bash
pnpm install
pnpm build    # type-check
pnpm test     # offline suite (MSW-intercepted, no keys) — the single
              # verification script; it drives the full pipeline
pnpm lint     # convention + format gates
```

## Commands

    judgebench <command> [flags]

| Command | Purpose | Key flags |
|----|----|----|
| `fetch` | Download + normalize a dataset into `data/<name>.jsonl` | `--dataset mtbench\|arena\|canaries`, `--limit N` |
| `validate` | Static checks: dataset schema, config, API keys present | `--config`, `--dataset` |
| `estimate` | Project run cost via a small live pilot (5 samples) | `--config`, `--judge …` |
| `run` | Execute judgments → `runs/<id>/judgments.jsonl` | `--judge provider/model` (repeatable), `--answer-mode`, `--structured/--no-structured`, `--labels A,B[,tie]`, `--swap both\|single`, `--rubric`, `--concurrency 8`, `--limit`, `--max-cost USD`, `--resume <id>` |
| `analyze` | Metrics from judgment files → `analysis.json` | `--runs runs/<id>…`, `--bootstrap 2000`, `--filter model_a==model_b` |
| `report` | Render markdown/CSV tables + Pareto data from analysis | `--format md\|csv\|json`, `--out reports/` |
| `replay` | Re-send one stored `llm_attempt` for debugging | `--run <id> --sample <sid>` |

Global flags (before or after the command): `--config <path>`,
`--env-file <path>`, `--json`, `--verbose`.

- Exit codes: `0` ok · `2` config/validation error · `3`
  provider/network error · `4` cost cap hit.
- Progress (samples done, live spend, retry warnings) goes to
  **stderr**; stdout stays pipeable. `--json` output is the only thing
  written to stdout — guarded by a test.
- Precedence: flag \> `judgebench.config.json` \> defaults.

## Quickstart (live)

``` bash
cp .env.example .env             # add OPENAI_API_KEY / ANTHROPIC_API_KEY
node scripts/setup.mjs           # deps + `judgebench` onto PATH (one-time)
judgebench fetch --dataset canaries
judgebench validate
judgebench estimate --judge openai/gpt-4o-mini --limit 5
judgebench run --judge openai/gpt-4o-mini --limit 10 --max-cost 1
judgebench analyze               # latest run → analysis.json
judgebench report                # → reports/REPORT-<run>.md/.csv
```

`judgebench.config.json` holds the experiment matrix (judges, modes,
label sets, dataset, concurrency); every flag overrides it. A `cells`
array expands a matrix — one cell per axis combination:

    {
      "dataset": "mtbench",
      "judges": ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"],
      "cells": [
        { "answerMode": "probabilities", "structuredOutputs": true },
        { "answerMode": "probabilities", "structuredOutputs": false },
        { "answerMode": "discrete", "structuredOutputs": true }
      ],
      "swap": "both",
      "labels": ["A", "B", "tie"]
    }

Third-party OpenAI-compatible endpoints (DeepSeek, Grok, …) are judge
objects instead of strings:

    {
      "judges": [
        "openai/gpt-4o-mini",
        { "model": "grok-4", "baseUrl": "https://api.x.ai/v1", "apiKeyEnv": "XAI_API_KEY" }
      ]
    }

### Providers

| Judge string | Endpoint | API key env | Notes |
|----|----|----|----|
| `openai/<model>` | api.openai.com | `OPENAI_API_KEY` | Responses API |
| `anthropic/<model>` | api.anthropic.com | `ANTHROPIC_API_KEY` | Messages API |
| `zai/<model>` | api.z.ai/api/paas/v4 | `ZAI_API_KEY` | e.g. `zai/glm-4.7-flashx` (GLM-4.7-FlashX) |
| `deepseek/<model>` | api.deepseek.com | `DEEPSEEK_API_KEY` | e.g. `deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro` |
| `opencode-go/<model>` | opencode.ai/zen/go/v1 | `OPENCODE_API_KEY` | OpenCode Go subscription; e.g. `opencode-go/deepseek-v4.1-flash`. judgebench self-identifies (`user-agent: judgebench` + stable `x-opencode-session` per judge) as the Go docs request |
| `laya/<model>` | local python process | — (none) | `laya/router`, `laya/english`, `laya/multilingual`, `laya/typed-decisions` from [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) |
| `{ "model": …, "baseUrl": … }` object | any OpenAI-compatible base URL | `apiKeyEnv` (default `OPENAI_API_KEY`) | fully custom endpoint |

Named presets also work as judge objects, where `baseUrl`/`apiKeyEnv`
override the preset (e.g. to route `opencode-go` through a local proxy):

    {
      "judges": [
        "zai/glm-4.7-flashx",
        "deepseek/deepseek-flash",
        "opencode-go/deepseek-v4.1-flash",
        { "provider": "laya", "model": "router", "label": "laya-router" }
      ]
    }

**Laya local judges** need the Python package on the machine running
judgebench (`pip install laya`); the interpreter defaults to `python3`
and can be changed via `LAYA_PYTHON`. The provider ships with
system-one-adapter: each judgment spawns a one-shot python process that
answers the typed questions natively (choice, score, and noul — no text
generation), so latencies are real but token counts (and therefore cost
columns) stay zero. Prefer `--swap single` if you want to keep run times
down.

**DeepSeek pricing note:** both DeepSeek direct and OpenCode Go bill
DeepSeek models at off-peak/peak rates; `pricing.json` carries the
off-peak (base) numbers and peak hours are 2× (DeepSeek: 01:00–04:00 and
06:00–10:00 UTC, weekdays).

## Data & run model

**Sample schema** (normalized by `fetch`, identical across sources):
`{ id, prompt, response_a, response_b, human_label, model_a, model_b }`

- `mtbench` — MT-Bench human judgments (majority label per question ×
  model pair), CC-BY-4.0, from
  [lmsys/mt_bench_human_judgments](https://huggingface.co/datasets/lmsys/mt_bench_human_judgments).
- `arena` — Chatbot-Arena-style preferences, Apache-2.0, from
  [lmarena-ai/arena-human-preference-55k](https://huggingface.co/datasets/lmarena-ai/arena-human-preference-55k).
- `canaries` — generated locally (deterministic, seeded):
  prompt-injection robustness canaries, scored separately from the main
  set so they cannot contaminate agreement numbers.

Licenses are checked at fetch time and recorded in
`data/<name>.meta.json`.

**Judgment record** (one JSONL line, append-only):
`{ sample_id, judge, config_hash, order, raw_label, probs, confidence, swap_consistent, usage, retry_reasons, n_retries_malformed_structure, model, ts, cell, human_label, error, error_type, llm_attempt }`
— the adapter’s `usage` + `debug` telemetry lands in storage verbatim,
so cost and reliability columns are free.

**Reproducibility:** every run directory gets a `manifest.json` — fully
resolved config, config hash, `system-one-adapter` semver (the coupling
tripwire), dataset content hash, date, model strings. `--resume` scans
completed `sample_id`s in the JSONL and continues; a mid-run
`--max-cost` guard trips exit code `4` using cumulative `usage` totals.

**Swap protocol** (`--swap both`): every sample is judged as `(A,B)` and
`(B,A)`. Consistent pairs → that label; inconsistent pairs → abstain
with the flip logged. In probabilities mode the debiased decision
averages `P(A)` across orders before argmax.

## Metrics (`analyze`)

Agreement with human majority (tie policy reported) · raw `P(choose A)`
· flip rate · debiased agreement · ECE + Brier on choice probabilities ·
confidence-vs-flip AUC (peak-based confidence recomputed locally —
`choiceConfidence` is not exported from the adapter, verified against
its `src/index.ts`) · tokens & cost per 1k judgments · p50/p95 latency
from `usage.latency` · malformed-retry rate per configuration ·
bootstrap CIs throughout · self-preference slice
(`--filter model_a==model_b`) · injection-robustness slice from the
`canaries` dataset.

`pricing.json` entries carry `as_of` dates;
`analyze`/`report`/`estimate` warn on missing or \>90-day-old prices.
Treat current values as unverified placeholders until priced against
provider billing docs.

## Hypotheses

The report auto-answers H1–H4 with CIs:

- **H1** cheap-judge agreement ≈ published GPT-4-judge numbers at a
  fraction of cost;
- **H2** structured outputs kill malformed retries at no accuracy cost;
- **H3** swap-averaging beats single-pass discrete;
- **H4** confidence predicts flips.

## Repository layout

    bin/
      judgebench.mjs      # bin target — spawns node on src/cli.ts
    scripts/
      setup.mjs           # deps + installs judgebench onto PATH
    src/
      cli.ts              # CLI entry — direct-invocation guard only
      commands/           # fetch validate estimate run analyze report replay
      core/
        config.ts         # arktype-validated config, matrix cells, config hash
        dataset.ts        # loaders → Sample[]; HF fetchers; canary generation
        judge.ts          # state + questions builder; one systemOne call
        swap.ts           # order randomization, swap protocol, debias math
        cost.ts           # pricing table, pilot projection, live cost guard
        rng.ts            # seeded RNG shared across the harness
      io/
        jsonl.ts          # append-only writer/reader
        manifest.ts       # resolved-config snapshot, hashes, resume index
        output.ts         # stdout/stderr discipline
      analysis/           # metrics bootstrap calibration
      pricing.json        # dated per-model price table
      tests/              # vitest + MSW interceptor (see note in src/tests/msw.ts)

The CLI is built with [commander](https://github.com/tj/commander.js)
and runtime validation is [arktype](https://arktype.io). Tests copy the
adapter’s (unpublished) MSW interceptor pattern; the small duplication
is accepted by design.
