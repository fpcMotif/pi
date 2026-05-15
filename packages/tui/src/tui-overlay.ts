import { isImageLine } from "./terminal-image.js";
import type { Component, OverlayAnchor, OverlayOptions, SizeValue } from "./tui.js";
import { SEGMENT_RESET } from "./tui-render-helpers.js";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

export interface OverlayEntry {
	readonly component: Component;
	readonly options?: OverlayOptions;
	hidden: boolean;
	focusOrder: number;
}

export interface OverlayLayout {
	readonly width: number;
	readonly row: number;
	readonly col: number;
	readonly maxHeight: number | undefined;
}

function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

function resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

export function resolveOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): OverlayLayout {
	const opt = options ?? {};

	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);

	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

	let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	width = Math.max(1, Math.min(width, availWidth));

	let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
	if (maxHeight !== undefined) {
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	}

	const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

	let row: number;
	let col: number;

	if (opt.row !== undefined) {
		if (typeof opt.row === "string") {
			const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxRow = Math.max(0, availHeight - effectiveHeight);
				const percent = parseFloat(match[1]) / 100;
				row = marginTop + Math.floor(maxRow * percent);
			} else {
				row = resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
			}
		} else {
			row = opt.row;
		}
	} else {
		const anchor = opt.anchor ?? "center";
		row = resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
	}

	if (opt.col !== undefined) {
		if (typeof opt.col === "string") {
			const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
			if (match) {
				const maxCol = Math.max(0, availWidth - width);
				const percent = parseFloat(match[1]) / 100;
				col = marginLeft + Math.floor(maxCol * percent);
			} else {
				col = resolveAnchorCol("center", width, availWidth, marginLeft);
			}
		} else {
			col = opt.col;
		}
	} else {
		const anchor = opt.anchor ?? "center";
		col = resolveAnchorCol(anchor, width, availWidth, marginLeft);
	}

	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;

	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

	return { width, row, col, maxHeight };
}

export function isOverlayVisible(entry: OverlayEntry, termWidth: number, termHeight: number): boolean {
	if (entry.hidden) return false;
	if (entry.options?.visible) {
		return entry.options.visible(termWidth, termHeight);
	}
	return true;
}

export function getTopmostVisibleOverlay<T extends OverlayEntry>(
	entries: readonly T[],
	termWidth: number,
	termHeight: number,
): T | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].options?.nonCapturing) continue;
		if (isOverlayVisible(entries[i], termWidth, termHeight)) {
			return entries[i];
		}
	}
	return undefined;
}

export function hasVisibleOverlay(entries: readonly OverlayEntry[], termWidth: number, termHeight: number): boolean {
	return entries.some((entry) => isOverlayVisible(entry, termWidth, termHeight));
}

export function compositeOverlays(
	lines: string[],
	overlayStack: readonly OverlayEntry[],
	termWidth: number,
	termHeight: number,
): string[] {
	if (overlayStack.length === 0) return lines;
	const result = [...lines];

	const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
	let minLinesNeeded = result.length;

	const visibleEntries = overlayStack.filter((entry) => isOverlayVisible(entry, termWidth, termHeight));
	visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
	for (const entry of visibleEntries) {
		const { component, options } = entry;
		const { width, maxHeight } = resolveOverlayLayout(options, 0, termWidth, termHeight);
		let overlayLines = component.render(width);

		if (maxHeight !== undefined && overlayLines.length > maxHeight) {
			overlayLines = overlayLines.slice(0, maxHeight);
		}

		const { row, col } = resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

		rendered.push({ overlayLines, row, col, w: width });
		minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
	}

	const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);
	while (result.length < workingHeight) {
		result.push("");
	}

	const viewportStart = Math.max(0, workingHeight - termHeight);

	for (const { overlayLines, row, col, w } of rendered) {
		for (let i = 0; i < overlayLines.length; i++) {
			const idx = viewportStart + row + i;
			if (idx >= 0 && idx < result.length) {
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
				result[idx] = compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
			}
		}
	}

	return result;
}

export function compositeLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);

	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	const resultWidth = visibleWidth(result);
	if (resultWidth <= totalWidth) {
		return result;
	}
	return sliceByColumn(result, 0, totalWidth, true);
}
