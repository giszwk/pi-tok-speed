/**
 * Decode-throughput accounting, following DeepSeek Harness (`dsh`):
 *
 *   tok/s    = Σ output tokens / Σ decode time      (ratio of sums, never a mean of rates)
 *   TTFT avg = Σ (request start -> first token) / samples
 *
 * `decode` is the window from the **first non-empty streamed delta** to the **assembled
 * response**, so prefill, queueing, TTFT, tool execution and idle time are all excluded.
 * TTFT is reported next to the rate instead of being folded into it — that is the whole
 * point of the dsh split, and it is why this rate no longer ramps up while a reply grows
 * and no longer collapses on every tool call.
 *
 * Every function here is pure so the math can be tested without a running Pi.
 */

/** Response start (ms since epoch) — Pi's `AssistantMessage.timestamp` is set before the HTTP call. */
export interface StepSample {
	ts: number;
	/** Output tokens counted for the rate. Includes thinking tokens, like the provider's usage. */
	tokens: number;
	/** Output tokens excluding reasoning/thinking, when the provider reports the split. */
	textTokens: number;
	/** Reasoning subset of `tokens` (0 when the provider does not report it). */
	reasoning: number;
	reasoningReported: boolean;
	/** First token -> response end, measured by Pi (ms). */
	decodeMs: number;
	/** Request start -> first token, observed by the extension (ms). */
	ttftMs: number;
	provider?: string;
	model?: string;
}

export interface Totals {
	tokens: number;
	textTokens: number;
	decodeMs: number;
	ttftMs: number;
	ttftMaxMs: number;
	samples: number;
	reasoningSamples: number;
	/** Steps dropped because a timing boundary or a usage sample was missing (dsh: degrade by omission). */
	skipped: number;
}

/** A decode window shorter than this cannot be a real measurement (batched/instant flushes). */
export const MIN_DECODE_MS = 50;
/** The in-flight step only joins the live readout after this much observed decoding. */
export const MIN_LIVE_DECODE_MS = 400;
/** Fallback density estimate while the provider has not reported usage yet. */
export const CHARS_PER_TOKEN = 4;

/** Session entry types written by this plugin (durable, never part of LLM context). */
export const SAMPLE_ENTRY = "tok-speed-sample";
export const RESET_ENTRY = "tok-speed-reset";

export function emptyTotals(): Totals {
	return {
		tokens: 0,
		textTokens: 0,
		decodeMs: 0,
		ttftMs: 0,
		ttftMaxMs: 0,
		samples: 0,
		reasoningSamples: 0,
		skipped: 0,
	};
}

export function addSample(totals: Totals, sample: StepSample): Totals {
	totals.tokens += sample.tokens;
	totals.textTokens += sample.textTokens;
	totals.decodeMs += sample.decodeMs;
	totals.ttftMs += sample.ttftMs;
	totals.ttftMaxMs = Math.max(totals.ttftMaxMs, sample.ttftMs);
	totals.samples += 1;
	if (sample.reasoningReported) totals.reasoningSamples += 1;
	return totals;
}

export function sumSamples(samples: readonly StepSample[]): Totals {
	const totals = emptyTotals();
	for (const sample of samples) addSample(totals, sample);
	return totals;
}

/**
 * Build a sample from a finished response, or `null` when it must not enter the accounting.
 *
 * Mirrors dsh's rule that a step missing either timing boundary or a valid provider usage
 * report drops out instead of skewing the figures, plus a decode-window floor that dsh is
 * missing (their issue #7960: whole-block arrivals collapse the window to 1-5 ms and emit
 * 10^5-10^6 tok/s).
 */
export function sampleFromResponse(input: {
	ts: number;
	output: number | undefined;
	reasoning: number | undefined;
	durationMs: number | undefined;
	ttftMs: number | null;
	provider?: string;
	model?: string;
}): StepSample | null {
	const output = input.output ?? 0;
	if (!Number.isFinite(output) || output <= 0) return null;
	if (input.ttftMs === null || !Number.isFinite(input.ttftMs) || input.ttftMs < 0) return null;
	const durationMs = input.durationMs;
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return null;

	const decodeMs = durationMs - input.ttftMs;
	if (decodeMs < MIN_DECODE_MS) return null;

	const reported = input.reasoning;
	const reasoningReported = reported !== undefined && Number.isFinite(reported) && reported > 0;
	const reasoning = reasoningReported ? Math.min(reported, output) : 0;

	return {
		ts: input.ts,
		tokens: output,
		textTokens: output - reasoning,
		reasoning,
		reasoningReported,
		decodeMs,
		ttftMs: input.ttftMs,
		provider: input.provider,
		model: input.model,
	};
}

/** tok/s including thinking tokens. `null` while nothing measurable has been recorded. */
export function rateOf(totals: Totals): number | null {
	if (totals.samples <= 0 || totals.decodeMs <= 0) return null;
	return (totals.tokens / totals.decodeMs) * 1000;
}

/** tok/s with thinking tokens excluded, when at least one sample reported them. */
export function textRateOf(totals: Totals): number | null {
	if (totals.reasoningSamples <= 0 || totals.decodeMs <= 0) return null;
	return (totals.textTokens / totals.decodeMs) * 1000;
}

export function avgTtftOf(totals: Totals): number | null {
	if (totals.samples <= 0) return null;
	return totals.ttftMs / totals.samples;
}

/** One decimal below 100, whole numbers above — the same convention as dsh's strip. */
export function formatRate(rate: number): string {
	return rate >= 100 ? rate.toFixed(0) : rate.toFixed(1);
}

export function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Shape check for data read back from session entries we do not control. */
export function isStepSample(value: unknown): value is StepSample {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.ts === "number" &&
		Number.isFinite(candidate.ts) &&
		typeof candidate.tokens === "number" &&
		Number.isFinite(candidate.tokens) &&
		typeof candidate.decodeMs === "number" &&
		Number.isFinite(candidate.decodeMs) &&
		typeof candidate.ttftMs === "number" &&
		Number.isFinite(candidate.ttftMs)
	);
}
