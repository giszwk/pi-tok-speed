/**
 * Builds the single-file distribution of the plugin.
 *
 * The package stays the canonical form (`src/metrics.ts` + `src/footer.ts` + `src/index.ts`).
 * `dist/pi-tok-speed.ts` is generated from those three files by inlining the local modules and
 * keeping only host imports, so the plugin can be dropped into any device's
 * `~/.pi/agent/extensions/` as one file with no packaging step.
 *
 *   node scripts/build-single.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), "utf8");

const HEADER = `/**
 * pi-tok-speed — decode throughput (tok/s) + TTFT for Pi's footer stats line.
 *
 * GENERATED FILE — do not edit. Source of truth: src/metrics.ts, src/footer.ts, src/index.ts
 * (rebuild with \`node scripts/build-single.mjs\`).
 *
 * Metric follows DeepSeek Harness: tok/s = Σ output tokens / Σ decode time, where decode runs
 * from the first non-empty streamed delta to the assembled response; TTFT is reported next to
 * the rate instead of being folded into it. Samples are persisted as session entries
 * (\`tok-speed-sample\`) so the aggregate survives /resume.
 *
 * Install: copy this file to ~/.pi/agent/extensions/pi-tok-speed.ts and run /reload.
 */

`;

/** Split a source file into kept host imports and the remaining body. */
function splitSource(source) {
	const hostImports = [];
	const body = [];
	const lines = source.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!/^import\s/.test(line)) {
			body.push(line);
			continue;
		}
		// Consume the whole statement: imports may span several lines.
		const statement = [line];
		while (!/from\s+"/.test(statement[statement.length - 1]) && !/;\s*$/.test(statement[statement.length - 1])) {
			statement.push(lines[++index] ?? "");
		}
		if (/from\s+"\.\//.test(statement.join("\n"))) continue; // local module: inlined below
		hostImports.push(statement.join("\n"));
	}
	return { hostImports, body: body.join("\n").trim() };
}

const sources = ["src/metrics.ts", "src/footer.ts", "src/index.ts"].map((path) => splitSource(read(path)));
const hostImports = [...new Set(sources.flatMap((source) => source.hostImports))];
const parts = sources.map((source) => source.body).filter(Boolean);

const output = [HEADER, hostImports.join("\n"), "", parts.join("\n\n")].join("\n") + "\n";

mkdirSync(new URL("dist/", root), { recursive: true });
const target = new URL("dist/pi-tok-speed.ts", root);
writeFileSync(target, output);
console.log(`wrote ${fileURLToPath(target)} (${output.length} bytes)`);
