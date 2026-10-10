/**
 * pi-tok-speed — decode throughput (tok/s) + TTFT for Pi's footer stats line.
 *
 * GENERATED FILE — do not edit. Source of truth: src/metrics.ts, src/footer.ts, src/index.ts
 * (rebuild with `node scripts/build-single.mjs`).
 *
 * Metric follows DeepSeek Harness: tok/s = Σ output tokens / Σ decode time, where decode runs
 * from the first non-empty streamed delta to the assembled response; TTFT is reported next to
 * the rate instead of being folded into it. Samples are persisted as session entries
 * (`tok-speed-sample`) so the aggregate survives /resume.
 *
 * Install: copy this file to ~/.pi/agent/extensions/pi-tok-speed.ts and run /reload.
 */


import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

/**
 * Splices the rate into Pi's built-in footer stats line.
 *
 * Pi's `FooterComponent.render(width)` returns `[pwdLine, statsLine, ...extensionStatuses]`.
 * `statsLine` is exactly `dim(statsLeft) + dim(rightAlignPadding + rightSide)`, so the end of
 * the left stats group is the only place where the dim suffix is immediately followed by the
 * dim prefix. Locating that boundary lets us splice right after `… (auto)` while keeping the
 * line at its exact terminal width:
 *
 *   1. pay with the right-align padding  -> model name stays right-aligned and uncut;
 *   2. padding too small (narrow terminal, long model name) -> let the right side lose its
 *      tail, exactly like the built-in footer already does when it runs out of room;
 *   3. still no room -> omit the readout instead of overflowing the line.
 *
 * The class is a public export, and in every runtime Pi maps `@earendil-works/pi-coding-agent`
 * for extensions to the very module the interactive mode instantiates, so this patches the
 * live footer (no Pi core change).
 */


/** Holds the untouched `render` so reloads do not stack patches. */
const PATCH_KEY = Symbol.for("@earendil-works/pi-coding-agent:tok-speed-patch");
/** Marker used to learn the theme's "dim" wrapper codes. */
const MARKER = "\u0000";

export interface FooterLabel {
	text: string;
	/** Theme token: "accent" while generating, "dim" once settled. */
	color: string;
}

export interface FooterLabelSource {
	/** Live candidates, most preferred first. Empty array hides the readout. */
	candidates(): FooterLabel[];
	/** Current theme; re-read on every render so `/theme` changes are picked up. */
	theme(): any;
}

interface Boundary {
	insertAt: number;
	padStart: number;
	pad: number;
	textWidth: number;
	text: string;
}

function locate(line: string, theme: any, text: string): Boundary | undefined {
	const wrapped: string = theme.fg("dim", MARKER);
	const at = wrapped.indexOf(MARKER);
	if (at <= 0) return undefined;
	const prefix = wrapped.slice(0, at);
	const suffix = wrapped.slice(at + MARKER.length);
	if (!prefix && !suffix) return undefined;

	const boundary = line.indexOf(suffix + prefix);
	if (boundary < 0) return undefined;

	const insertAt = boundary + suffix.length;
	const padStart = insertAt + prefix.length;
	let pad = 0;
	while (line[padStart + pad] === " ") pad++;
	return { insertAt, padStart, pad, textWidth: visibleWidth(text), text };
}

/** Insert `text` at the end of the left stats group, keeping the terminal width exact. */
export function spliceLabel(line: string, found: Boundary, width: number): string | undefined {
	const head = line.slice(0, found.insertAt);
	const tail = line.slice(found.padStart);

	if (found.pad >= found.textWidth + 2) {
		return head + ` ${found.text} ` + line.slice(found.padStart + found.textWidth + 2);
	}

	for (const candidate of [` ${found.text} `, ` ${found.text}`]) {
		const joined = head + candidate + tail;
		const fitted = visibleWidth(joined) <= width ? joined : truncateToWidth(joined, width, "");
		if (fitted.includes(found.text)) return fitted;
	}
	return undefined;
}

/**
 * Wrap `FooterComponent.prototype.render`. Returns the uninstall function.
 * Safe to call repeatedly: the true original is saved once, the newest patch always wins.
 */
export function installFooterLabel(source: FooterLabelSource): () => void {
	const proto = FooterComponent.prototype as any;
	if (!proto[PATCH_KEY]) proto[PATCH_KEY] = proto.render;
	const originalRender = proto[PATCH_KEY];

	const patchedRender = function (this: unknown, width: number): string[] {
		const base = originalRender.call(this, width) as string[];
		try {
			const theme = source.theme();
			if (!theme?.fg || !Array.isArray(base) || base.length < 2) return base;
			for (const label of source.candidates()) {
				const text = theme.fg(label.color, label.text);
				const found = locate(base[1], theme, text);
				if (!found) continue;
				const spliced = spliceLabel(base[1], found, width);
				if (spliced) return [base[0], spliced, ...base.slice(2)];
			}
		} catch {
			// Never break the footer because of the readout.
		}
		return base;
	};
	proto.render = patchedRender;

	return () => {
		if (proto.render === patchedRender) proto.render = originalRender;
	};
}

/**
 * pi-tok-speed — decode-throughput (tok/s) + TTFT in Pi's footer stats line.
 *
 * Metric follows DeepSeek Harness (`dsh`):
 *   tok/s    = Σ output tokens / Σ decode time      ratio of sums, never a mean of rates
 *   TTFT avg = Σ (request start -> first token) / samples
 *
 * `decode` runs from the first non-empty streamed delta to the assembled response, so
 * prefill, queueing, TTFT, tool time and idle time stay out of the rate. Pi measures the
 * total response time (`AssistantMessage.durationMs`, monotonic, request start -> end) but
 * does not record the first token, so this extension observes it on `message_update` and
 * persists the resulting sample itself (`pi.appendEntry`) to survive `/resume`.
 *
 * See README.md for the full data flow and the guard rails.
 */


interface OpenStep {
	/** Request start (`AssistantMessage.timestamp`), before the HTTP call. */
	ts: number;
	/** Wall time of the first non-empty delta; 0 until it arrives. */
	firstDeltaAt: number;
	chars: number;
	reportedTokens: number;
	provider?: string;
	model?: string;
}

interface Side {
	ui?: { theme: any };
	fallbackTheme?: any;
	step: OpenStep | null;
	totals: Totals;
	/** Samples computed but not yet written to the session. */
	pending: StepSample[];
	/** Samples at or before this timestamp are ignored (set by `/tok reset`). */
	resetAt: number;
}

/** Session entries are extension input; treat their payload as unknown. */
interface BranchEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; usage?: { output?: number; reasoning?: number }; durationMs?: number };
}

function isResetEntry(entry: BranchEntry): entry is BranchEntry & { data: { at: number } } {
	return (
		entry.type === "custom" &&
		entry.customType === RESET_ENTRY &&
		typeof entry.data === "object" &&
		entry.data !== null &&
		typeof (entry.data as { at?: unknown }).at === "number"
	);
}

export default function (pi: ExtensionAPI) {
	const side: Side = {
		step: null,
		totals: emptyTotals(),
		pending: [],
		resetAt: 0,
	};

	function theme(): any {
		try {
			const live = (side.ui as any)?.theme;
			if (live?.fg) return live;
		} catch {
			// Theme access is only a display concern.
		}
		return side.fallbackTheme;
	}

	/** The in-flight response, eligible for the live readout once it has decoded for a while. */
	function liveSample(): StepSample | null {
		const step = side.step;
		if (!step || step.firstDeltaAt === 0) return null;
		const decodeMs = Date.now() - step.firstDeltaAt;
		if (decodeMs < MIN_LIVE_DECODE_MS) return null;
		const tokens = step.reportedTokens > 0 ? step.reportedTokens : step.chars / CHARS_PER_TOKEN;
		if (!(tokens > 0)) return null;
		return {
			ts: step.ts,
			tokens,
			textTokens: tokens,
			reasoning: 0,
			reasoningReported: false,
			decodeMs,
			ttftMs: Math.max(0, step.firstDeltaAt - step.ts),
			provider: step.provider,
			model: step.model,
		};
	}

	function candidates(): FooterLabel[] {
		const live = liveSample();
		const totals: Totals = live ? addSample({ ...side.totals }, live) : side.totals;
		const rate = rateOf(totals);
		if (rate === null) return [];

		const streaming = live !== null;
		const color = streaming ? "accent" : "dim";
		const short = `${streaming ? "~" : ""}${formatRate(rate)} tok/s`;
		const ttft = avgTtftOf(side.totals);
		if (ttft === null) return [{ text: short, color }];
		return [
			{ text: `${short} · TTFT ${formatSeconds(ttft)}`, color },
			{ text: short, color },
		];
	}

	function report(): string {
		const totals = side.totals;
		const lines: string[] = [];
		const rate = rateOf(totals);
		if (rate === null) {
			lines.push("tok/s — no complete sample yet");
		} else {
			lines.push(
				`tok/s ${formatRate(rate)} (decode · ${formatSeconds(totals.decodeMs)} over ${totals.samples} sample${
					totals.samples === 1 ? "" : "s"
				} · ${totals.tokens} tok)`,
			);
			const ttft = avgTtftOf(totals);
			lines.push(`TTFT avg ${formatSeconds(ttft ?? 0)} · max ${formatSeconds(totals.ttftMaxMs)}`);
			const textRate = textRateOf(totals);
			if (textRate !== null) lines.push(`text-only ${formatRate(textRate)} tok/s (thinking excluded)`);
		}
		const live = liveSample();
		if (live) lines.push(`generating: ~${formatRate((live.tokens / live.decodeMs) * 1000)} tok/s so far`);
		if (totals.skipped > 0) lines.push(`skipped ${totals.skipped} (no timing or usage)`);
		return lines.join("\n");
	}

	function rebuild(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
		side.totals = emptyTotals();
		side.pending = [];
		side.resetAt = 0;
		for (const entry of entries) {
			if (isResetEntry(entry)) side.resetAt = Math.max(side.resetAt, entry.data.at);
		}
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SAMPLE_ENTRY) continue;
			if (!isStepSample(entry.data) || entry.data.ts <= side.resetAt) continue;
			addSample(side.totals, entry.data);
		}
	}

	/** Write the samples collected during the turn; called once the entries are durable. */
	function flush(): void {
		if (side.pending.length === 0) return;
		for (const sample of side.pending) pi.appendEntry(SAMPLE_ENTRY, sample);
		side.pending = [];
	}

	const uninstall = installFooterLabel({ candidates, theme });

	pi.on("session_start", async (_event, ctx) => {
		side.ui = ctx.ui as any;
		side.fallbackTheme = ctx.ui.theme;
		side.step = null;
		rebuild(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		side.ui = ctx.ui as any;
		side.fallbackTheme = ctx.ui.theme;
		const message = event.message as { timestamp?: number; provider?: string; model?: string };
		side.step = {
			ts: message.timestamp ?? Date.now(),
			firstDeltaAt: 0,
			chars: 0,
			reportedTokens: 0,
			provider: message.provider,
			model: message.model,
		};
	});

	pi.on("message_update", async (event) => {
		const streamEvent: any = event.assistantMessageEvent;
		const step = side.step;
		if (!streamEvent || !step) return;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) {
			return;
		}
		const delta: string = streamEvent.delta ?? "";
		if (delta.length > 0 && step.firstDeltaAt === 0) step.firstDeltaAt = Date.now();
		step.chars += delta.length;
		// Providers that report cumulative usage mid-stream (Anthropic) keep the live number exact.
		const reported = streamEvent.partial?.usage?.output;
		if (typeof reported === "number" && reported > step.reportedTokens) step.reportedTokens = reported;
	});

	pi.on("message_end", async (event) => {
		const message: any = event.message;
		if (message?.role !== "assistant") return;
		const step = side.step;
		side.step = null;
		if (!step) return;

		const ts = message.timestamp ?? step.ts;
		const ttftMs = step.firstDeltaAt === 0 ? null : step.firstDeltaAt - ts;
		const sample = sampleFromResponse({
			ts,
			output: message.usage?.output,
			reasoning: message.usage?.reasoning,
			durationMs: message.durationMs ?? Date.now() - ts,
			ttftMs,
			provider: message.provider ?? step.provider,
			model: message.model ?? step.model,
		});
		if (!sample) {
			if ((message.usage?.output ?? 0) > 0) side.totals.skipped += 1;
			return;
		}
		addSample(side.totals, sample);
		side.pending.push(sample);
	});

	// `turn_end` runs after the turn's entries are persisted, so our records land after them.
	pi.on("turn_end", async () => {
		flush();
	});
	pi.on("agent_settled", async () => {
		flush();
	});

	pi.registerCommand("tok", {
		description: "Show tok/s accounting (decode throughput + TTFT), or `/tok reset` to start over",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "reset") {
				side.totals = emptyTotals();
				side.pending = [];
				side.resetAt = Date.now();
				pi.appendEntry(RESET_ENTRY, { at: side.resetAt });
				ctx.ui.notify("tok-speed: counters reset", "info");
				return;
			}
			ctx.ui.notify(report(), "info");
		},
	});

	pi.on("session_shutdown", async () => {
		flush();
		uninstall();
	});
}
