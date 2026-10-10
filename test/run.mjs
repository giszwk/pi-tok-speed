/**
 * Offline verification for pi-tok-speed.
 *
 * Loads the real extension through jiti with the same module aliases Pi uses, and drives it
 * against the real FooterComponent, so both the accounting and the footer splice are covered.
 *
 *   node test/run.mjs
 */

import { pathToFileURL } from "node:url";

const INSTALL = "C:/Users/admin/.pi/agent/install/releases/1.1.0/node_modules/";
const BASE = INSTALL + "@earendil-works/pi-coding-agent/dist/";
const TUI = INSTALL + "@earendil-works/pi-tui/dist/index.js";

const tui = await import(pathToFileURL(TUI).href);
const themeMod = await import(pathToFileURL(BASE + "modes/interactive/theme/theme.js").href);
themeMod.initTheme("dark");
const theme = themeMod.theme;
const { FooterComponent } = await import(pathToFileURL(BASE + "modes/interactive/components/footer.js").href);

const { createJiti } = await import(pathToFileURL(INSTALL + "jiti/lib/jiti.cjs").href).then((m) => m.default ?? m);
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": BASE + "index.js",
		"@earendil-works/pi-tui": TUI,
	},
	interopDefault: true,
});

let failures = 0;
const check = (label, condition, detail = "") => {
	const ok = Boolean(condition);
	if (!ok) failures++;
	console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok || !detail ? "" : ` -> ${detail}`}`);
};
const near = (actual, expected, tolerance = 0.06) => typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
const plain = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ pure math
console.log("\n== metrics: dsh decode accounting ==");
const {
	emptyTotals,
	addSample,
	rateOf,
	textRateOf,
	avgTtftOf,
	sampleFromResponse,
	formatRate,
	formatSeconds,
} = await jiti.import("../src/metrics.ts");

check("formatRate keeps a decimal below 100", formatRate(94.12) === "94.1", formatRate(94.12));
check("formatRate rounds at/above 100", formatRate(123.4) === "123", formatRate(123.4));
check("formatSeconds", formatSeconds(725) === "0.7s", formatSeconds(725));

const sampleA = sampleFromResponse({ ts: 1000, output: 240, reasoning: 0, durationMs: 3000, ttftMs: 500 });
const sampleB = sampleFromResponse({ ts: 5000, output: 60, reasoning: 0, durationMs: 2000, ttftMs: 900 });
check("sample subtracts TTFT from the decode window", sampleA?.decodeMs === 2500, String(sampleA?.decodeMs));
const totals = emptyTotals();
addSample(totals, sampleA);
addSample(totals, sampleB);
check("rate is a ratio of sums, not a mean of rates", near(rateOf(totals), (300 / 3600) * 1000), String(rateOf(totals)));
check("the two per-response rates (96.0 / 54.5) are not what is shown", near((240 / 2500) * 1000, 96) && near((60 / 1100) * 1000, 54.545));
check("TTFT average is reported separately", near(avgTtftOf(totals), 700, 1), String(avgTtftOf(totals)));
check("text-only rate is null without reasoning reporting", textRateOf(totals) === null);

const withThinking = emptyTotals();
addSample(withThinking, sampleFromResponse({ ts: 1, output: 100, reasoning: 60, durationMs: 2000, ttftMs: 0 }));
check("thinking is excluded only in the text-only rate", textRateOf(withThinking) === 20 && rateOf(withThinking) === 50);

check("no usage -> no sample", sampleFromResponse({ ts: 1, output: 0, reasoning: 0, durationMs: 2000, ttftMs: 10 }) === null);
check("no first token observed -> no sample", sampleFromResponse({ ts: 1, output: 10, reasoning: 0, durationMs: 2000, ttftMs: null }) === null);
check("missing durationMs -> no sample", sampleFromResponse({ ts: 1, output: 10, reasoning: 0, durationMs: undefined, ttftMs: 10 }) === null);
check(
	"batch-arrival guard: 5 ms decode window is rejected (dsh issue #7960)",
	sampleFromResponse({ ts: 1, output: 900, reasoning: 0, durationMs: 5, ttftMs: 0 }) === null,
);

// ------------------------------------------------------------------ fake runtime
const usage = (input, output, cacheRead, cost, reasoning) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	...(reasoning === undefined ? {} : { reasoning }),
	totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

let branch = [];
let contextPercent = 5.8;
const session = {
	state: {
		model: { id: "claude-sonnet-4-5", provider: "anthropic", reasoning: true, contextWindow: 1000000 },
		thinkingLevel: "medium",
	},
	sessionManager: {
		getCwd: () => "D:/work/agent-skill",
		getSessionName: () => undefined,
		getEntryCount: () => branch.length,
		getSessionId: () => "sess-1",
		getLeafId: () => "leaf-1",
		getEntries: () => branch,
		getBranch: () => branch,
	},
	getContextUsage: () => ({ tokens: 58000, contextWindow: 1000000, percent: contextPercent }),
	routedModel: undefined,
	modelRuntime: { isUsingSubscription: () => false },
};
const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 2,
	onBranchChange: () => () => {},
};

const handlers = new Map();
const appended = [];
const notifications = [];
const pi = {
	on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
	registerCommand: (name, options) => handlers.set(`command:${name}`, [options.handler]),
	appendEntry: (customType, data) => {
		appended.push({ customType, data });
		branch.push({ type: "custom", customType, data });
	},
};
const ctx = {
	ui: { theme, notify: (message, type) => notifications.push([type, message]) },
	mode: "tui",
	hasUI: true,
	sessionManager: session.sessionManager,
	getContextUsage: session.getContextUsage,
};
const fire = async (name, event) => {
	for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
};
const renderFooter = (width) => {
	const component = new FooterComponent(session, footerData); // fresh: stats are cached per entry count
	component.setAutoCompactEnabled(true);
	return component.render(width);
};
const statsLine = (width) => plain(renderFooter(width)[1]);
const rateIn = (line) => {
	const match = /~?([\d.]+) tok\/s/.exec(line);
	return match ? Number(match[1]) : null;
};

console.log("\n== extension end to end ==");
const entry = process.argv[2] ?? "../src/index.ts";
console.log(`       entry: ${entry}`);
const plugin = await jiti.import(entry, { default: true });
check("default export is the factory", typeof plugin === "function", typeof plugin);
plugin(pi);
check("registers /tok", handlers.has("command:tok"));
check(
	"registers the lifecycle events",
	["session_start", "message_start", "message_update", "message_end", "turn_end", "session_shutdown"].every((n) => handlers.has(n)),
);

await fire("session_start", { type: "session_start", reason: "startup" });
check("fresh session leaves the built-in footer untouched", !statsLine(120).includes("tok/s"), statsLine(120));

// turn 1: 500 ms TTFT, then 240 tokens over 2500 ms of decode
const t0 = Date.now();
await fire("message_start", {
	type: "message_start",
	message: { role: "assistant", timestamp: t0, provider: "anthropic", model: "claude-sonnet-4-5" },
});
check("no readout before the first token", !statsLine(120).includes("tok/s"), statsLine(120));
await sleep(500);
await fire("message_update", {
	type: "message_update",
	assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400), partial: { usage: { output: 0 } } },
});
await sleep(500);
const live = statsLine(120);
check("live readout is marked in-flight", /~[\d.]+ tok\/s/.test(live), live);

await fire("message_end", {
	type: "message_end",
	message: { role: "assistant", timestamp: t0, usage: usage(40000, 240, 1100000, 0.035), durationMs: 3000 },
});
const first = statsLine(120);
const firstRate = rateIn(first);
check("settled readout shows tok/s and TTFT", firstRate > 90 && firstRate < 100 && /TTFT 0\.5s/.test(first), first);
check("no tilde once settled", !first.includes("~"));
await fire("turn_end", { type: "turn_end", turnIndex: 0 });
check("sample persisted on turn_end", appended.length === 1 && appended[0].customType === "tok-speed-sample", JSON.stringify(appended));

// turn 2: slow prefill (900 ms) and a small response (60 tokens / 1100 ms decode)
const t1 = Date.now();
await fire("message_start", {
	type: "message_start",
	message: { role: "assistant", timestamp: t1, provider: "anthropic", model: "claude-sonnet-4-5" },
});
check("aggregate survives the start of a new step (no dip to zero)", statsLine(120) === first, `${statsLine(120)} != ${first}`);
await sleep(900);
await fire("message_update", {
	type: "message_update",
	assistantMessageEvent: { type: "toolcall_delta", delta: "y".repeat(120), partial: { usage: { output: 0 } } },
});
await fire("message_end", {
	type: "message_end",
	message: { role: "assistant", timestamp: t1, usage: usage(20000, 60, 400000, 0.01), durationMs: 2000 },
});
await fire("turn_end", { type: "turn_end", turnIndex: 1 });
const afterTool = statsLine(120);
const aggregateRate = rateIn(afterTool);
console.log(`       turn 1 = ${firstRate} tok/s, turn 2 = 54.5 tok/s per response -> aggregate: ${aggregateRate} tok/s`);
check(
	"aggregate stays between the two per-response rates instead of collapsing to the slow step",
	aggregateRate < firstRate && aggregateRate > 70 && aggregateRate < 90,
	afterTool,
);
check("TTFT average updated", /TTFT 0\.7s/.test(afterTool), afterTool);

// a batched step must be rejected instead of producing 10^5+ tok/s
const before = statsLine(120);
await fire("message_start", { type: "message_start", message: { role: "assistant", timestamp: Date.now() - 4 } });
await fire("message_update", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "z".repeat(4000) } });
await fire("message_end", {
	type: "message_end",
	message: { role: "assistant", timestamp: Date.now() - 4, usage: usage(1, 900, 0, 0.01), durationMs: 5 },
});
await fire("turn_end", { type: "turn_end", turnIndex: 2 });
check("batched step does not enter the rate", statsLine(120) === before, statsLine(120));
await fire("command:tok", "");
check("/tok counts the rejected step", (notifications.at(-1)?.[1] ?? "").includes("skipped 1"), JSON.stringify(notifications.at(-1)));

// persistence round trip
const persisted = branch.filter((e) => e.customType === "tok-speed-sample").map((e) => e.data);
check("only the two valid samples were persisted", persisted.length === 2, String(persisted.length));
await fire("session_start", { type: "session_start", reason: "resume" });
check("resume rebuilds the identical rate", statsLine(120) === afterTool, `${statsLine(120)} != ${afterTool}`);
await fire("command:tok", "");
const report = notifications.at(-1)?.[1] ?? "";
check("/tok reports samples, decode time and TTFT", /tok\/s [\d.]+ \(decode .* 2 samples/.test(report) && report.includes("TTFT avg"), JSON.stringify(report));

// /tok reset
await fire("command:tok", "reset");
check("reset clears the readout", !statsLine(120).includes("tok/s"), statsLine(120));
await fire("session_start", { type: "session_start", reason: "resume" });
check("reset marker survives a rebuild", !statsLine(120).includes("tok/s"), statsLine(120));

// ------------------------------------------------------------------ footer splice
console.log("\n== footer splice ==");
const labelRe = /~?[\d.]+ tok\/s/;
ctx.sessionManager.getBranch = () => [
	{
		type: "custom",
		customType: "tok-speed-sample",
		data: { ts: Date.now(), tokens: 300, textTokens: 300, reasoning: 0, reasoningReported: false, decodeMs: 3550, ttftMs: 700 },
	},
];
await fire("session_start", { type: "session_start", reason: "resume" });
for (const width of [200, 120, 100, 80, 70, 60, 45, 34, 24]) {
	const lines = renderFooter(width);
	const over = lines.map((line, i) => [i, tui.visibleWidth(line)]).filter(([, w]) => w > width);
	check(`width ${width}: no overflow`, over.length === 0, JSON.stringify(over));
	const stats = plain(lines[1]);
	if (width >= 60) check(`width ${width}: readout present`, labelRe.test(stats), stats);
	if (width >= 100) check(`width ${width}: model name kept`, stats.includes("claude-sonnet-4-5"), stats);
}
for (const percent of [92, 75]) {
	contextPercent = percent;
	const lines = renderFooter(120);
	check(`context ${percent}% (colored stats): readout survives`, labelRe.test(plain(lines[1])), plain(lines[1]));
	check(`context ${percent}%: width stays exact`, tui.visibleWidth(lines[1]) === 120);
}
contextPercent = 5.8;

// ------------------------------------------------------------------ teardown
await fire("session_shutdown", { type: "session_shutdown", reason: "reload" });
check("uninstall restores the built-in footer", !plain(renderFooter(120)[1]).includes("tok/s"), plain(renderFooter(120)[1]));

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
