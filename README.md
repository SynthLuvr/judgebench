# judgebench

A standalone LLM-as-judge benchmark CLI. judgebench judges pairs of
model responses against human preference labels and reports judge
agreement, position bias, calibration, cost, and reliability.

The single runtime dependency is
[system-one-adapter](https://www.npmjs.com/package/system-one-adapter);
everything else is Node built-ins (`node:util` `parseArgs`,
`--env-file`) or dev tooling (typescript, tsx, vitest, msw, ts-canon).
Node `==26`, ESM-only, `noEmit` type-check with tsx running sources.

## Status

**Phase 0 scaffold.** The CLI router, command stubs, core type contract,
pricing table, and full ts-canon toolchain are in place; every command
exits `2` with a “not implemented” note until its phase lands.

## Install

``` bash
pnpm install
cp .env.example .env   # add provider keys (not needed for smoke)
```

## Usage

``` bash
judgebench <command> [flags]
```

| Command    | Purpose                                                    |
|------------|------------------------------------------------------------|
| `fetch`    | Download + normalize a dataset into `data/<name>.jsonl`    |
| `validate` | Static checks: dataset schema, config resolution, API keys |
| `estimate` | Project run cost via a small live pilot (5 samples)        |
| `run`      | Execute judgments → `runs/<id>/judgments.jsonl`            |
| `analyze`  | Metrics from judgment files → `analysis.json`              |
| `report`   | Render markdown/CSV tables + Pareto data from analysis     |
| `smoke`    | Full offline pipeline through MSW — no network, no keys    |
| `replay`   | Re-send one stored `llm_attempt` through its provider      |

Global flags: `--config <path>`, `--env-file <path>`, `--json`
(machine-readable stdout), `--verbose`. Exit codes: `0` ok, `2`
config/validation error, `3` provider/network error, `4` cost cap hit.
Progress goes to **stderr**; stdout stays pipeable. Precedence: flag \>
config file \> defaults. `judgebench.config.json` holds the experiment
matrix (judges, answer modes, label sets, dataset, concurrency); every
flag overrides it.

## Layout

    src/
      cli.ts        argv routing only — thin
      commands/     fetch validate estimate run analyze report smoke replay
      core/         dataset.ts judge.ts swap.ts cost.ts
      io/           jsonl.ts manifest.ts
      analysis/     metrics.ts bootstrap.ts calibration.ts
      pricing.json  dated per-model price table (per 1M tokens)
      tests/        vitest suites + MSW interceptor module
    judgebench.config.json   experiment matrix
    data/          normalized datasets (small committed, large gitignored)
    runs/          run outputs (gitignored)

## Development

``` bash
pnpm build     # type-check (noEmit)
pnpm lint      # ts-canon: biome, oxlint, ast-grep, jscpd, audit
pnpm test      # vitest with v8 coverage (80% thresholds)
pnpm format    # arrow-conv, strip-braces, biome, pandoc markdown
pnpm smoke     # offline end-to-end run via MSW stubs
```

## Phases

| Phase | Deliverable |
|----|----|
| 0 — Scaffold | Repo, router, `fetch`, `smoke`, MSW test module |
| 1 — Core loop | `run` with resume/cost-guard, `analyze`, minimal `report` |
| 2 — Matrix & science | Config matrix, multi-judge, calibration, `estimate`, Pareto |
| 3 — Extensions | `--rubric`, 3-label ties, self-preference, `replay` |

Hypotheses under test: **H1** cheap-judge agreement ≈ published
GPT-4-judge numbers at a fraction of the cost; **H2** structured outputs
kill malformed retries at no accuracy cost; **H3** swap-averaging beats
single-pass discrete; **H4** confidence predicts flips.

## Notes

- Consume only the public `system-one-adapter` surface; the run
  manifest’s recorded adapter semver is the coupling tripwire.
- `src/pricing.json` entries carry `as_of` dates; current values are
  placeholders pending verification. `analyze`/`report` will warn on
  missing or \>90-day-old prices.
- Dataset licensing is verified at fetch time in Phase 0.
