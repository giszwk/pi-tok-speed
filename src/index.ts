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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installFooterLabel, type FooterLabel } from "./footer.ts";
import {
	CHARS_PER_TOKEN,
	MIN_LIVE_DECODE_MS,
	RESET_ENTRY,
	SAMPLE_ENTRY,
	addSample,
	avgTtftOf,
	emptyTotals,
	formatRate,
	formatSeconds,
	isStepSample,
	rateOf,
	sampleFromResponse,
	textRateOf,
	type StepSample,
	type Totals,
} from "./metrics.ts";

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
