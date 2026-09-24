# Walkthrough: can a judge model attribute a commit message to its diff?

A worked, verified evaluation of judgebench on **material written
entirely by humans: this repository’s own git history**. Nothing is
invented for this walkthrough — no fictional product, no synthetic
samples, no downloads. The five founding commits (the evaluation set is
pinned at `7b6ebed`, where this walkthrough was recorded — see Step 1),
their diffs, and their commit messages were written by the project’s
author; the ground truth for every pair comes from the recorded history
itself.

## The scenario

You want to know whether an LLM judge can reliably answer a question
that automated commit tooling keeps asking: **given a diff, which of two
candidate commit messages did the author actually write for it?** The
same capability underlies commit-message generators (does the generated
message actually match the change?), AI-attribution checks (boilerplate
messages that fit any diff), and review tooling that summarizes changes.
Here the question is asked about real commits, and the answer key is
history: one candidate is the message the author actually committed with
that diff, the other is a real message the author wrote for a
*different* commit in this same project.

The judge under test is Claude Haiku 4.5 via the Claude Code CLI’s own
login — no API keys, no network beyond localhost and the model call.

## Prerequisites

``` bash
node --version          # v26.x — see "engines" in package.json
pnpm install
node scripts/setup.mjs  # one-time: puts `judgebench` on your PATH
claude login            # the judge reuses the Claude Code CLI login
```

## Step 1 — derive the evaluation set from history

This script reads `git log` pinned at `7b6ebed` — the commit this
walkthrough was recorded at — and builds pairs mechanically: for each of
the five commits, the genuine message (response A, the recorded truth)
against the message of a different commit (decoys at offsets +1 and +3,
deterministic), with the diff taken from `git show` and truncated at
6,000 characters. Every word in every pair is the author’s.

``` bash
node --input-type=module - <<'EOF'
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const log = git(["log", "--reverse", "--format=%H%x00%s%x00%b%x01", "7b6ebed"]);
const commits = log
  .split("\u0001")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "")
  .map((entry) => {
    const [sha, subject, body] = entry.split("\u0000");
    return { sha, subject, body: body.trim() };
  });

const messageOf = (c) => (c.body === "" ? c.subject : `${c.subject}\n\n${c.body}`);
const diffOf = (sha) => {
  const full = git(["show", "--format=", "--stat", "--patch", "-U1", sha]);
  return full.length > 6000 ? `${full.slice(0, 6000)}\n… (diff truncated)` : full;
};

const samples = [];
commits.forEach((commit, i) => {
  const diff = diffOf(commit.sha);
  const short = commit.sha.slice(0, 7);
  for (const offset of [1, 3]) {
    const decoy = commits[(i + offset) % commits.length];
    samples.push({
      id: `cm-${short}-vs-${decoy.sha.slice(0, 7)}`,
      prompt:
        "Exactly one of the two candidate commit messages below was written " +
        "by this project's author for the diff shown; the other belongs to " +
        "a different commit in the same project.\n\n" +
        `Diff of the commit in question:\n${diff}\n\n` +
        "Candidate 1:\n" + messageOf(commit) +
        "\n\nCandidate 2:\n" + messageOf(decoy),
      response_a: "Candidate 1",
      response_b: "Candidate 2",
      human_label: "A",
      model_a: `genuine ${short}`,
      model_b: `decoy ${decoy.sha.slice(0, 7)}`,
    });
  }
});

mkdirSync("data", { recursive: true });
writeFileSync("data/mtbench.jsonl", samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
console.log(`wrote data/mtbench.jsonl: ${samples.length} pairs from ${commits.length} commits`);
EOF
```

    wrote data/mtbench.jsonl: 10 pairs from 5 commits

(Parked in the `mtbench` slot — judgebench’s generic local slot — so the
canaries-only injection slice does not misfire on this data. The slot
name is a workaround until a custom-dataset flag exists.)

One minimal config; everything else rides on flags:

``` bash
echo '{"dataset": "mtbench", "judges": ["claude-code/claude-haiku-4-5"]}' > data/provenance.config.json
judgebench validate --config data/provenance.config.json
```

    ok: config data/provenance.config.json: 1 judges × 1 cells, dataset mtbench, swap=both
    ok: data/mtbench.jsonl: 10 samples valid
    ok: mtbench: no license metadata (run `judgebench fetch --dataset mtbench` to record it)
    ok: judge claude-code/claude-haiku-4-5 runs through the Claude Code CLI (install it and run `claude login`) — no API key required
    ok: pricing for claude-code/claude-haiku-4-5 is 342 days old — verify against provider billing
    validation passed
    EXIT=0

## Step 2 — judge every pair, both orders

``` bash
judgebench run --config data/provenance.config.json --swap both --concurrency 4
judgebench analyze --runs <run-id>
```

    run-20260922-063154-da3c: 20 judgments stored (0 errors), spend ~$1.2142
    EXIT=0                                   # 20 = 10 pairs × 2 orders, 1m49s wall

    claude-code/claude-haiku-4-5 [probabilities/structured=true/labels=A|B|tie/rubric=off]:
      agreement 1.000, debiased 0.900, flips 0.700, ece 0.500

## Step 3 — read the results (the interesting part)

Per-pair, from `runs/<run-id>/judgments.jsonl`:

| pair (genuine vs decoy)            | orders agree? | final verdict    | correct? |
|------------------------------------|---------------|------------------|----------|
| ec819d8 (license) vs 7b6ebed       | no — flipped  | A (debiased)     | yes      |
| 777fc40 (scaffold) vs ca160da      | no — flipped  | A (debiased)     | yes      |
| ec819d8 (license) vs 49334d9       | yes           | A                | yes      |
| 777fc40 (scaffold) vs ec819d8      | yes           | A                | yes      |
| 49334d9 (CLI \#1) vs ca160da       | no — flipped  | A (debiased)     | yes      |
| ca160da (providers \#2) vs ec819d8 | no — flipped  | **B (debiased)** | **no**   |
| 7b6ebed (configure \#3) vs 777fc40 | no — flipped  | A (debiased)     | yes      |
| 49334d9 (CLI \#1) vs 777fc40       | no — flipped  | A (debiased)     | yes      |
| ca160da (providers \#2) vs 7b6ebed | yes           | A                | yes      |
| 7b6ebed (configure \#3) vs 49334d9 | no — flipped  | A (debiased)     | yes      |

What the numbers say:

- **Where the judge was consistent, it was right every time** — all 3
  order-stable pairs picked the genuine message, including the subtle
  license-vs-CLI pairing.
- **Flip rate 0.700** — 7 of 10 pairs reversed when the response order
  swapped. The judge’s position bias on diff-heavy prompts is large, and
  a single-order harness would never surface it: it would just report
  0.9 correct with no hint that 7 of those answers were order-dependent
  coin flips that happened to land well.
- **Swap-averaging recovered 6 of the 7 flips** — debiased agreement
  0.900 vs single-order 0.900, but with a crucial difference: the swap
  protocol *tells you* which pairs are unstable, instead of silently
  including order-dependent luck.
- **The one miss is meaningful**: `ca160da vs ec819d8` — the
  providers-refactor commit misattributed against the license commit.
  With only five commits the decoy pool is small and this pairing is
  maximally distant; a larger repo with richer decoys is the natural
  next experiment.
- **Calibration is poor (ECE 0.500)**: on the flipped pairs the judge
  reported 0.95–0.99 confidence *in both directions*. It does not know
  when it is guessing by position.
- **Cost is real**: \$60.71 per 1k judgments at tabled rates (~55.7k
  input tokens each — diffs are long, and the CLI judge’s own system
  prompt rides on every call). The 6,000-character diff cap is the main
  cost knob; a cheaper provider is the scale path.

## Step 4 — verify without trusting the tool

`node verify-prov.mjs <run-id>` (appendix) re-derives the headline
numbers from the raw judgments, importing nothing from judgebench:

    {"pairs":10,"flips":7,"agreement_consistent":1,"agreement_debiased":0.9,
     "errors":0,"retried":0,"input_tokens_total":1114015}

Every value matches the tool’s analysis (agreement 1.000 on consistent
pairs, debiased 0.900, flips 0.700, zero errors). The bootstrap CI on
the consistent subset is degenerate (\[1, 1\]) because only 3 of 10
pairs were stable — an honest small-n warning from the tool, not a
glitch.

## Step 5 — replay one judgment for debugging

`replay` re-sends a stored attempt through the same provider — here it
confirms the stored verdict reproduces:

``` bash
judgebench replay --run run-20260922-063154-da3c --sample cm-ec819d8-vs-7b6ebed
```

    {
      "run_id": "run-20260922-063154-da3c",
      "sample_id": "cm-ec819d8-vs-7b6ebed",
      "judge": "claude-code/claude-haiku-4-5",
      "order": "AB",
      "model": "claude-haiku-4-5",
      "text": "{\"answers\":{\"verdict\":{\"A\":0.98,\"B\":0.02,\"tie\":0}}}",
      "input_tokens": 14233,
      "output_tokens": 449
    }

The stored run gave P(A) = 0.99 for this pair; the replay gave 0.98.
Same decision, slightly different probabilities — real inference, not a
lookup.

## What you would do with this in practice

- **Gate judge or prompt changes on flip rate and malformed-retry
  rate**, not just accuracy: this run would have passed an accuracy
  check (0.9–1.0) while carrying a 70% order-instability rate and 0.5
  ECE — exactly the failures that surface later as inconsistent reviews.
- **Grow the decoy pool**: five commits make decoys easy; a hundred
  commits from your real repos make the task honestly hard, and the same
  script scales to it unchanged.
- **Trim the diff cap** before scaling up — it is the dominant cost
  lever (\$60.71/1k here).

## Reproducing and cleaning up

The evaluation set regenerates from history at any time (Step 1); the
scratch files are gitignored:

``` bash
rm -f data/mtbench.jsonl data/provenance.config.json verify-prov.mjs
rm -rf runs/run-*
```

## Appendix — the independent verification script

``` js
import { readFileSync } from "node:fs";

const records = readFileSync(`runs/${process.argv[2]}/judgments.jsonl`, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const canonical = (label, order) =>
  label === "tie" ? "tie" : order === "AB" ? label : label === "A" ? "B" : "A";

const bySample = new Map();
for (const record of records) {
  const list = bySample.get(record.sample_id) ?? [];
  list.push(record);
  bySample.set(record.sample_id, list);
}

const labels = ["A", "B", "tie"];
let agree = 0, agreeN = 0, debAgree = 0, pairs = 0, flips = 0;
let errors = 0, retried = 0;
for (const [, list] of bySample) {
  const ab = list.find((r) => r.order === "AB");
  const ba = list.find((r) => r.order === "BA");
  const first = canonical(ab.raw_label, "AB");
  const second = canonical(ba.raw_label, "BA");
  pairs += 1;
  if (first !== second) flips += 1;
  else {
    agreeN += 1;
    if (first === ab.human_label) agree += 1;
  }
  if (ab.probs !== null && ba.probs !== null) {
    const mean = [0, 1, 2].map((i) => (ab.probs[i] + ba.probs[i]) / 2);
    let best = 0;
    for (let i = 1; i < 3; i++) if (mean[i] > mean[best]) best = i;
    if (labels[best] === ab.human_label) debAgree += 1;
  }
}
for (const record of records) {
  if (record.error !== null) errors += 1;
  if (record.n_retries_malformed_structure > 0) retried += 1;
}
const inTok = records.reduce(
  (sum, r) => sum + (r.usage?.input_tokens_total ?? 0), 0);

console.log(JSON.stringify({
  pairs, flips,
  agreement_consistent: +(agree / agreeN).toFixed(3),
  agreement_debiased: +(debAgree / pairs).toFixed(3),
  errors, retried, input_tokens_total: inTok,
}, null, 2));
```
