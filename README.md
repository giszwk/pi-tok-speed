# pi-tok-speed

**Decode throughput (`tok/s`) and TTFT, spliced into Pi's built-in footer stats line.**

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-d36ce3.svg)](https://pi.dev/packages)
[![release](https://img.shields.io/github/v/tag/giszwk/pi-tok-speed?label=release&color=58b551)](https://github.com/giszwk/pi-tok-speed/tags)

```
↑40k ↓14k R1.1M CH99.6% $0.035 5.8%/1.0M (auto) 58.3 tok/s · TTFT 1.8s   (anthropic) claude-…
```

A Pi extension that adds two numbers to the stats line Pi already draws. It patches nothing in Pi
core — it wraps `FooterComponent.prototype.render`, a public export, and edits the line in place.

## What you get

- **Live while generating** — `~58.3 tok/s` in the accent colour, updating as the response streams.
- **Aggregate once settled** — the value after a response is a sum over every measured response in
  the session, not just the last one, so a slow tool-call round does not reset your readout.
- **TTFT beside the rate** — how long you waited for the first token, next to how fast tokens then
  arrived. They are separate numbers on purpose (see below).
- **TTFT and rate degrade together** — narrow terminal: `58.3 tok/s · TTFT 1.8s` → `58.3 tok/s` →
  nothing. The stats line keeps its exact width and the model name is never pushed off the edge.
- **Survives `/resume`** — samples are persisted in the session, so the aggregate is rebuilt from
  the branch you resumed.
- **`/tok`** — the full accounting on demand, including a thinking-excluded rate and how many
  responses were rejected. `/tok reset` starts over.

## The metric

| Quantity | Definition |
|---|---|
| `tok/s` | `Σ output tokens / Σ decode time` — a **ratio of sums**, never a mean of per-response rates |
| `decode` | **first non-empty streamed delta → assembled response** |
| `TTFT` | request start → first token, averaged over sampled responses, shown **next to** the rate |

Excluded from the rate by construction: prefill, request queueing, TTFT, tool execution, and idle
time between messages.

This is the accounting used by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`), and it is the reason the readout behaves differently from a naive "tokens ÷ elapsed"
number:

- it does **not ramp up** while a reply grows, because the fixed first-token wait is not in the
  denominator;
- it does **not collapse on every tool call**, because a slow, tool-call-shaped response is weighted
  into the sum instead of replacing the displayed value — in the test suite a 96.0 tok/s response
  and a 54.5 tok/s response show as one **83.8 tok/s** aggregate;
- an in-flight response joins the aggregate as soon as it has decoded for ≥ 400 ms, marked with a
  `~` prefix, so the number moves while generating and lands on the settled value when the response
  ends.

### Why TTFT is not folded in

TTFT and decode rate are limited by different things, so combining them produces a number that
describes neither:

| | Driven by | As context grows |
|---|---|---|
| TTFT | queueing + prefill (reading the whole prompt, cached or not) | degrades, roughly linearly |
| decode rate | per-token autoregressive decoding | roughly constant |

Amortising TTFT into the rate means dividing a nearly constant quantity by one that changes with
prompt size — hence the creeping upward and collapsing behaviour above. Reporting both separately
tells you *where* the time went: 58 tok/s with a 12 s TTFT is a prefill or network problem, not a
generation problem.

## How the numbers are obtained

| Needed | Source |
|---|---|
| Request start | `MessageStartEvent.message.timestamp` — set before the HTTP call, so queueing counts toward TTFT |
| First token | first `text_delta` / `thinking_delta` / `toolcall_delta` with a non-empty `delta` in `message_update` (the `*_start` events carry an empty block, so they cannot be used) |
| Response end | `MessageEndEvent.message.durationMs` (monotonic, measured by Pi) → `decodeMs = durationMs − ttftMs` |
| Tokens | `message.usage.output`; `usage.reasoning` (a subset) drives the optional thinking-excluded rate |
| Mid-stream tokens | provider-reported `partial.usage.output` when present (Anthropic); otherwise a `chars / 4` density estimate |

Pi does not persist a first-token time, so each finished response is stored as one durable custom
session entry (`pi.appendEntry("tok-speed-sample", …)`, never part of LLM context) and
`session_start` rebuilds the aggregate from `ctx.sessionManager.getBranch()` — branch-scoped and
`/resume`-safe.

## Guard rails

- `output > 0`, `durationMs > 0`, TTFT observed in this process, **`decodeMs ≥ 50 ms`**.
- The 50 ms floor is deliberate. `dsh` guards only `decodeMs > 0`, so a step whose blocks arrive
  packed collapses the decode window to 1–5 ms and emits 10<sup>5</sup>–10<sup>6</sup> tok/s into the
  session total ([#7960 — "unguarded when a step arrives as whole blocks"](https://github.com/deepseek-ai/deepseek-harness/discussions/7960)).
  Rejected steps are counted and reported by `/tok` as `skipped`.
- Responses with no timing or no usage **drop out** of the accounting instead of skewing it (the
  `dsh` "degrade by omission" rule), including every message created before this plugin was
  installed.
- Thinking tokens are included in `tok/s` — they are tokens you waited for, and `usage.output`
  contains them. `/tok` additionally reports a text-only rate. Note that `dsh` currently drops
  reasoning tokens from its token-usage projection
  ([#2338](https://github.com/deepseek-ai/deepseek-harness/discussions/2338)); this plugin does not.
- Every footer edit is wrapped so that any failure leaves the built-in line untouched.

## Install

Requires a working Pi install (verified against Pi 1.1.0) and `git` for the git source.

### From git (recommended)

```bash
pi install git:github.com/giszwk/pi-tok-speed@v0.1.1
```

Pi clones the repo into its managed `git/` directory and records the source in
`~/.pi/agent/settings.json`. Pinning a tag keeps upgrades deliberate: change the ref and run
`pi update --extensions`, or drop `@v0.1.1` to follow the default branch.

### As a single file

`dist/pi-tok-speed.ts` is the whole plugin in one generated file, with no dependencies beyond the
packages Pi already provides:

```bash
cp dist/pi-tok-speed.ts ~/.pi/agent/extensions/
```

Then `/reload` (or restart Pi). `dist/` is regenerated from `src/` by
`node scripts/build-single.mjs`.

### From a local checkout

```bash
git clone https://github.com/giszwk/pi-tok-speed.git
pi install ./pi-tok-speed
pi list          # verify
```

Local packages are loaded from the resolved path and are never copied or `npm install`-ed, so edits
under `src/` take effect on `/reload`. Keep the path stable, or `pi remove <old-path>` and
`pi install <new-path>`.

Install only one of these. A git install and a copied `extensions/` file are two identities for the
same plugin, and both would write into the stats line. If you used the earlier standalone
`tok-speed.ts`, delete it first.

After installing, the readout appears once the **next** response finishes: earlier messages were
never observed, so they stay out of the accounting. Until then the footer looks exactly like the
built-in one, and `/tok` reports `no complete sample yet`.

## Commands

| Command | Effect |
|---|---|
| `/tok` | Rate, decode time, sample count, TTFT avg/max, thinking-excluded rate, skipped steps |
| `/tok reset` | Drop all samples (writes a reset marker so the rebuild stays consistent) |

## Tuning

In `src/metrics.ts`:

- `MIN_DECODE_MS` (50) — decode-window floor for a valid sample.
- `MIN_LIVE_DECODE_MS` (400) — how long the in-flight response must decode before joining the live readout.
- `CHARS_PER_TOKEN` (4) — density fallback used only until the provider reports usage.

In `src/index.ts`, `candidates()` controls the label: return `[]` to hide the readout, or drop the
`· TTFT …` entry to keep only the rate. It also decides the fallback chain, so the label
automatically steps down from `58.3 tok/s · TTFT 1.8s` to `58.3 tok/s` to nothing as the terminal
narrows.

## Limitations

- The readout needs the TUI. In `print` / `json` / `rpc` modes samples are still recorded, but
  nothing is drawn.
- Messages from before installation have no first-token observation and are excluded from the rate.
- Pi persists no per-chunk timing, so the in-flight number is a density estimate until `usage`
  arrives. A provider that streams cumulative usage (Anthropic) keeps it exact.

## Development

```bash
node scripts/build-single.mjs               # src/*.ts -> dist/pi-tok-speed.ts
node test/run.mjs                           # suite against src/
node test/run.mjs ../dist/pi-tok-speed.ts   # same suite against the single-file build
```

The suite runs the plugin through its real lifecycle events against the real `FooterComponent`
taken from your local Pi install (discovered via `PI_MANAGED_INSTALL_ROOT`, falling back to
`~/.pi/agent/install`). It covers the accounting (ratio of sums vs. mean of rates, every rejection
guard), the end-to-end flow (live marker, persistence round trip, reset markers, patch teardown),
and a width sweep from 200 down to 24 columns that asserts the line never overflows and the model
name survives on wide terminals.

Layout:

```
src/metrics.ts   pure accounting: samples, guards, formatting
src/footer.ts    stats-line splice, width degradation, the prototype patch
src/index.ts     event wiring, persistence, /tok command
scripts/         single-file build
test/run.mjs     offline verification
dist/            generated single-file build (committed)
```

## License

[MIT](LICENSE)
