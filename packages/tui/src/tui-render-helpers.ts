import { deleteKittyImage, isImageLine } from "./terminal-image.js";
import { normalizeTerminalOutput, visibleWidth } from "./utils.js";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

export const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

export function extractKittyImageIds(line: string): number[] {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return [];

	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return [];

	const params = line.slice(paramsStart, paramsEnd);
	for (const param of params.split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "i" || value === undefined) continue;
		const id = Number(value);
		if (Number.isInteger(id) && id > 0 && id <= 0xffffffff) {
			return [id];
		}
	}
	return [];
}

export function applyLineResets(lines: string[]): string[] {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!isImageLine(line)) {
			lines[i] = normalizeTerminalOutput(line) + SEGMENT_RESET;
		}
	}
	return lines;
}

export function collectKittyImageIds(lines: readonly string[]): Set<number> {
	const ids = new Set<number>();
	for (const line of lines) {
		for (const id of extractKittyImageIds(line)) {
			ids.add(id);
		}
	}
	return ids;
}

export function deleteKittyImages(ids: Iterable<number>): string {
	let buffer = "";
	for (const id of ids) {
		buffer += deleteKittyImage(id);
	}
	return buffer;
}

export function expandLastChangedForKittyImages(
	previousLines: readonly string[],
	firstChanged: number,
	lastChanged: number,
): number {
	let expandedLastChanged = lastChanged;
	for (let i = firstChanged; i < previousLines.length; i++) {
		if (extractKittyImageIds(previousLines[i]).length > 0) {
			expandedLastChanged = Math.max(expandedLastChanged, i);
		}
	}
	return expandedLastChanged;
}

export function deleteChangedKittyImages(
	previousLines: readonly string[],
	firstChanged: number,
	lastChanged: number,
): string {
	if (firstChanged < 0 || lastChanged < firstChanged) return "";

	const ids = new Set<number>();
	const maxLine = Math.min(lastChanged, previousLines.length - 1);
	for (let i = firstChanged; i <= maxLine; i++) {
		for (const id of extractKittyImageIds(previousLines[i] ?? "")) {
			ids.add(id);
		}
	}

	return deleteKittyImages(ids);
}

export function extractCursorPosition(
	lines: string[],
	height: number,
	cursorMarker: string,
): { row: number; col: number } | null {
	const viewportTop = Math.max(0, lines.length - height);
	for (let row = lines.length - 1; row >= viewportTop; row--) {
		const line = lines[row];
		const markerIndex = line.indexOf(cursorMarker);
		if (markerIndex !== -1) {
			const beforeMarker = line.slice(0, markerIndex);
			const col = visibleWidth(beforeMarker);

			lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + cursorMarker.length);

			return { row, col };
		}
	}
	return null;
}
