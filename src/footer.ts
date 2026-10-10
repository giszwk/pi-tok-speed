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

import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
