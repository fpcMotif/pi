/**
 * Pure diff/replace helpers for the Effect-shaped `Edit` tool (ADR-0010).
 *
 * This is the rewrite-lane counterpart of `src/core/tools/edit-diff.ts`. It
 * carries only the *pure* string algorithms the tool handler needs — line-
 * ending detection, BOM handling, fuzzy matching, multi-edit application, and
 * unified-diff rendering. The legacy module's filesystem-touching preview
 * helpers (`computeEditsDiff`) stay behind on the `src/` lane; the rewrite does
 * its IO through the `EditOperations` Service instead.
 *
 * The one behavioural change versus the legacy module: `applyEditsToNormalizedContent`
 * throws a *typed* `EditApplyError` (with a `reason` discriminator) rather than
 * a bare `Error`, so the Effect handler can map each apply-step failure onto a
 * typed `EditError` reason instead of pattern-matching message strings — the
 * "typed errors at every boundary" goal from ADR-0001.
 *
 * Unicode-class regexes are built from `String.fromCharCode` so this source
 * file stays pure ASCII (no literal smart quotes / dashes / exotic spaces).
 */

import * as Diff from "diff";

/** UTF-8 byte-order mark. */
const BOM = String.fromCharCode(0xfeff);

/** Smart single quotes U+2018..U+201B -> ASCII apostrophe. */
const SMART_SINGLE_QUOTES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x201a, 0x201b)}]`, "g");
/** Smart double quotes U+201C..U+201F -> ASCII double quote. */
const SMART_DOUBLE_QUOTES = new RegExp(`[${String.fromCharCode(0x201c, 0x201d, 0x201e, 0x201f)}]`, "g");
/** Unicode hyphens/dashes U+2010..U+2015 plus U+2212 minus -> ASCII hyphen. */
const UNICODE_DASHES = new RegExp(
	`[${String.fromCharCode(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212)}]`,
	"g",
);
/** Exotic spaces (NBSP, U+2002..U+200A, narrow/medium NBSP, ideographic space) -> ASCII space. */
const UNICODE_SPACES = (() => {
	const range = Array.from({ length: 0x200a - 0x2002 + 1 }, (_, i) => String.fromCharCode(0x2002 + i)).join("");
	return new RegExp(`[${String.fromCharCode(0xa0)}${range}${String.fromCharCode(0x202f, 0x205f, 0x3000)}]`, "g");
})();

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(SMART_SINGLE_QUOTES, "'")
		.replace(SMART_DOUBLE_QUOTES, '"')
		.replace(UNICODE_DASHES, "-")
		.replace(UNICODE_SPACES, " ");
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	readonly found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	readonly index: number;
	/** Length of the matched text */
	readonly matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	readonly usedFuzzyMatch: boolean;
	/** The content to use for replacement operations. */
	readonly contentForReplacement: string;
}

export interface Edit {
	readonly oldText: string;
	readonly newText: string;
}

interface MatchedEdit {
	readonly editIndex: number;
	readonly matchIndex: number;
	readonly matchLength: number;
	readonly newText: string;
}

export interface AppliedEditsResult {
	readonly baseContent: string;
	readonly newContent: string;
}

/** Discriminator for every apply-step failure `applyEditsToNormalizedContent` can raise. */
export type EditApplyReason = "empty-old-text" | "no-match" | "ambiguous-match" | "overlapping-edits" | "no-change";

/** Typed error thrown by `applyEditsToNormalizedContent`; mapped to `EditError` at the Effect boundary. */
export class EditApplyError extends Error {
	readonly reason: EditApplyReason;
	constructor(reason: EditApplyReason, message: string) {
		super(message);
		this.name = "EditApplyError";
		this.reason = reason;
	}
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** Strip a UTF-8 BOM if present; return both the BOM (if any) and the text without it. */
export function stripBom(content: string): { readonly bom: string; readonly text: string } {
	return content.startsWith(BOM) ? { bom: BOM, text: content.slice(1) } : { bom: "", text: content };
}

/**
 * Build the fuzzy-normalized form of `content` while recording, for each output
 * character, the `[start, end)` half-open span in the ORIGINAL string it came
 * from. This lets a fuzzy match — which is located in normalized space — be
 * mapped back onto the original byte offsets so only the matched span is
 * rewritten and the rest of the file stays byte-for-byte intact.
 */
function buildFuzzyIndexMap(content: string): { readonly normalized: string; readonly spans: ReadonlyArray<readonly [number, number]> } {
	const out: string[] = [];
	const spans: Array<readonly [number, number]> = [];
	const lines = content.split("\n");

	let origOffset = 0;
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];

		// NFKC-expand the line, tracking each output char's original index.
		const expanded: Array<{ readonly ch: string; readonly start: number; readonly end: number }> = [];
		let col = 0;
		for (const cp of line) {
			const folded = cp.normalize("NFKC");
			for (const ch of folded) {
				expanded.push({ ch, start: origOffset + col, end: origOffset + col + cp.length });
			}
			col += cp.length;
		}

		// Drop trailing-whitespace chars (the trimEnd in normalizeForFuzzyMatch).
		let lastKept = expanded.length;
		while (lastKept > 0 && /\s/.test(expanded[lastKept - 1].ch)) {
			lastKept--;
		}

		for (let i = 0; i < lastKept; i++) {
			const { ch, start, end } = expanded[i];
			out.push(foldChar(ch));
			spans.push([start, end]);
		}

		if (lineIdx < lines.length - 1) {
			// The "\n" separator: maps to the single original newline char.
			out.push("\n");
			const nlIndex = origOffset + line.length;
			spans.push([nlIndex, nlIndex + 1]);
			origOffset = nlIndex + 1;
		}
	}

	return { normalized: out.join(""), spans };
}

/** Apply the length-preserving smart-punctuation/space folding to one NFKC char. */
function foldChar(ch: string): string {
	return ch
		.replace(SMART_SINGLE_QUOTES, "'")
		.replace(SMART_DOUBLE_QUOTES, '"')
		.replace(UNICODE_DASHES, "-")
		.replace(UNICODE_SPACES, " ");
}

interface MatchSpan {
	readonly start: number;
	readonly end: number;
	readonly usedFuzzyMatch: boolean;
}

/**
 * Locate `oldText` within `content`, returning the match span in ORIGINAL
 * (`content`) coordinates. Tries an exact byte match first; only when that
 * fails does it fall back to fuzzy (whitespace-/punctuation-insensitive)
 * matching, mapping the normalized-space hit back onto the original offsets.
 */
function locateMatch(content: string, oldText: string): MatchSpan | undefined {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { start: exactIndex, end: exactIndex + oldText.length, usedFuzzyMatch: false };
	}

	const { normalized, spans } = buildFuzzyIndexMap(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (fuzzyOldText.length === 0) {
		return undefined;
	}
	const fuzzyIndex = normalized.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return undefined;
	}

	const start = spans[fuzzyIndex][0];
	const end = spans[fuzzyIndex + fuzzyOldText.length - 1][1];
	return { start, end, usedFuzzyMatch: true };
}

/**
 * Count occurrences of `oldText` in `content`. When the match was found
 * exactly, count in EXACT-byte space — a text that is genuinely unique in its
 * exact form must not be rejected as ambiguous just because a second occurrence
 * would collide under fuzzy normalization. Only when no exact match exists do
 * we count in fuzzy-normalized space (matching how the edit was actually found).
 */
function countOccurrences(content: string, oldText: string, usedFuzzyMatch: boolean): number {
	if (!usedFuzzyMatch) {
		return content.split(oldText).length - 1;
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function notFoundError(path: string, editIndex: number, totalEdits: number): EditApplyError {
	return new EditApplyError(
		"no-match",
		totalEdits === 1
			? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
			: `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function duplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): EditApplyError {
	return new EditApplyError(
		"ambiguous-match",
		totalEdits === 1
			? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
			: `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function emptyOldTextError(path: string, editIndex: number, totalEdits: number): EditApplyError {
	return new EditApplyError(
		"empty-old-text",
		totalEdits === 1
			? `oldText must not be empty in ${path}.`
			: `edits[${editIndex}].oldText must not be empty in ${path}.`,
	);
}

function noChangeError(path: string, totalEdits: number): EditApplyError {
	return new EditApplyError(
		"no-change",
		totalEdits === 1
			? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
			: `No changes made to ${path}. The replacements produced identical content.`,
	);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space.
 *
 * @throws {EditApplyError} on empty oldText, no match, ambiguous match,
 *   overlapping edits, or a replacement that produced identical content.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: ReadonlyArray<Edit>,
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw emptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	// Every edit is matched against — and applied to — the ORIGINAL LF-normalized
	// content. A fuzzy edit rewrites only its matched span; the rest of the file
	// stays byte-for-byte intact (no whole-file fuzzy-normalization).
	const baseContent = normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const match = locateMatch(baseContent, edit.oldText);
		if (!match) {
			throw notFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText, match.usedFuzzyMatch);
		if (occurrences > 1) {
			throw duplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: match.start,
			matchLength: match.end - match.start,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new EditApplyError(
				"overlapping-edits",
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw noChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { readonly diff: string; readonly firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}
