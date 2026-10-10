# pi-tok-speed

Decode throughput (`tok/s`) and TTFT, spliced into Pi's built-in footer stats line:

```
↑40k ↓14k R1.1M CH99.6% $0.035 5.8%/1.0M (auto) 58.3 tok/s · TTFT 1.8s   (anthropic) claude-…
```

No Pi core change: the extension wraps `FooterComponent.prototype.render` (a public export that is
the very class the interactive mode instantiates) and edits the stats line in place.

## Metric (DeepSeek Harness accounting)

| Quantity | Definition |
|---|---|
| `tok/s` | `Σ output tokens / Σ decode time` — a **ratio of sums**, never a mean of per-response rates |
| `decode` | **first non-empty streamed delta → assembled response** |
| `TTFT` | request start → first token, averaged over sampled responses and shown **next to** the rate |

Excluded from the rate, by construction: prefill, request queueing, TTFT, tool execution, idle
time between messages. TTFT is reported separately instead of being amortized into the rate.

This is why the readout behaves differently from an end-to-end number:

- it does **not ramp up** while a reply grows (the fixed TTFT is not in the denominator),
- it does **not collapse on every tool call** (a slow, tool-call-shaped response is weighted into
  the sum instead of replacing the displayed value; in the test, 96.0 and 54.5 tok/s steps show as
  one 83.8 tok/s aggregate),
- the in-flight response joins the aggregate as soon as it has decoded for ≥ 400 ms, marked with a
  `~` prefix, so the number moves while generating and lands exactly on the settled value.

## How it gets the data

| Needed | Source |
|---|---|
| Request start | `MessageStartEvent.message.timestamp` (set before the HTTP call, so queueing counts toward TTFT) |
| First token | first `text_delta` / `thinking_delta` / `toolcall_delta` with a non-empty `delta` in `message_update` (`*_start` events carry an empty block, so they cannot be used) |
| Response end | `MessageEndEvent.message.durationMs` (monotonic, measured by Pi) → `decodeMs = durationMs − ttftMs` |
| Tokens | `message.usage.output`; `usage.reasoning` (a subset) drives the optional text-only rate |
| Mid-stream tokens | provider-reported `partial.usage.output` when present (Anthropic); otherwise a `chars / 4` density estimate |

Pi does not persist a first-token time, so each finished response is stored as one durable custom
entry (`pi.appendEntry("tok-speed-sample", …)`, never part of LLM context) and `session_start`
rebuilds the aggregate from `ctx.sessionManager.getBranch()` — branch-scoped and `/resume`-safe.

## Guard rails

- `output > 0`, `durationMs > 0`, TTFT observed in this process, **`decodeMs ≥ 50 ms`**.
- The 50 ms floor is deliberate: DeepSeek Harness is missing it (their issue #7960) and whole-block
  arrivals collapse the decode window to 1–5 ms, emitting 10^5–10^6 tok/s into the session total.
  Rejected steps are counted and reported by `/tok` as `skipped`.
- Responses with no timing or no usage **drop out** of the accounting instead of skewing it (the
  dsh rule), including every message created before this plugin was installed.
- Thinking tokens are included in `tok/s` (they are tokens you waited for, and `usage.output`
  contains them); `/tok` additionally reports a text-only rate. Note that dsh currently drops
  reasoning tokens entirely from its projection (their issue #2338), which this plugin does not.

## Install

```bash
pi install ./pi-tok-speed     # local path; or npm:/git: once published
/reload                       # or restart pi
```

Remove the `tok-speed.ts` single-file extension first if you installed it earlier — two patches
would both write into the stats line.

## Install on another device

`pi install` records the package in `~/.pi/agent/settings.json` and, for local sources, loads it
from the resolved path **without copying** it. Settings are not synced between devices, so each one
needs its own install step. Four routes, easiest first:

1. **One file, no packaging.** Copy `dist/pi-tok-speed.ts` to `~/.pi/agent/extensions/` (create the
directory) and restart Pi. `dist/` is generated from `src/` by `node scripts/build-single.mjs`; the
test suite runs against both entries.
2. **Copy the directory** and install it by path:
   ```bash
   pi install /path/to/pi-tok-speed
   pi list          # verify
   ```
   Local packages are not copied or `npm install`-ed: the host packages are supplied by Pi, so the
   folder alone is enough. Keep the path stable, or `pi remove <old-path>` + `pi install <new-path>`.
3. **Git source** (version-pinned, works without an npm account): push this directory to a
   repository, then on every device:
   ```bash
   pi install git:github.com/<you>/pi-tok-speed@v0.1.0
   pi update --extensions     # reconcile later
   ```
4. **npm source** (best for many devices): remove `"private": true`, set a publishable name (for
   example `@<you>/pi-tok-speed`), add a `repository` field, then `npm publish`. On each device:
   ```bash
   pi install npm:@<you>/pi-tok-speed
   ```
   The `pi-package` keyword also makes it discoverable in the Pi package gallery. `files` already
   limits the tarball to `src`, `dist` and the README.

After any of these, `/reload` and run `/tok`: it should report the accounting (or
`no complete sample yet` until one response finishes). The first response after install is what
creates the first sample; earlier messages have no first-token observation and stay excluded.

## Commands

| Command | Effect |
|---|---|
| `/tok` | Report rate, decode time, sample count, TTFT avg/max, text-only rate, skipped steps |
| `/tok reset` | Drop all samples (writes a reset marker so the rebuild stays consistent) |

## Tuning

In `src/metrics.ts`:

- `MIN_DECODE_MS` (50) — decode-window floor for a valid sample.
- `MIN_LIVE_DECODE_MS` (400) — how long the in-flight response must decode before joining the live readout.
- `CHARS_PER_TOKEN` (4) — density fallback used only until the provider reports usage.

In `src/index.ts` — `candidates()` controls the label; return `[]` to hide the readout, or drop the
`· TTFT …` entry to keep only the rate. The label automatically falls back from
`58.3 tok/s · TTFT 1.8s` to `58.3 tok/s` and then to nothing when the terminal is too narrow.

## Test

```bash
node test/run.mjs
```

Runs the pure accounting plus the real extension against the real `FooterComponent`: ratio-of-sums,
TTFT separation, all rejection guards, persistence round trip, reset markers, patch teardown, and a
width sweep (200 → 24 columns, including colored context percentages) that asserts the line never
overflows and the model name survives on wide terminals.

## Limitations

- The readout needs the TUI; in `print`/`json`/`rpc` modes samples are still recorded but nothing is drawn.
- Messages from before installation have no first-token observation and are excluded from the rate.
- Pi persists no per-chunk timing, so the in-flight number is a density estimate until `usage`
  arrives (a provider that streams cumulative usage, such as Anthropic, keeps it exact).
