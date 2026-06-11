/**
 * Deeper behaviour / edge / latency tests for the pure helpers in
 * `effect/tools/edit-diff.ts`.
 *
 * These intentionally go past the happy paths in `edit-diff.test.ts`:
 * - exact vs fuzzy (whitespace-insensitive) replacement and what each returns,
 * - the lossy "whole content gets fuzzy-normalised" behaviour when ANY edit is
 *   fuzzy (trailing whitespace on unrelated lines is dropped),
 * - the surprising `countOccurrences`-always-normalises behaviour where a text
 *   that is unique in its EXACT form is still rejected as `ambiguous-match`
 *   because it collapses onto another occurrence under NFKC / smart-quote
 *   folding,
 * - multi-edit application order with differently-sized replacements and the
 *   reverse-application offset stability that protects it,
 * - a replacement that itself contains the search text (no infinite / re-match),
 * - BOM + CRLF/LF preservation via the round-trip helpers around the pure core,
 * - empty-search / empty-file boundaries,
 * - exact unified-diff output (line numbers, +/-/space markers) for a real
 *   two-hunk change, and
 * - a latency assertion: a single edit against a 200k-line normalised content
 *   stays well under a wall-clock bound and does not scale pathologically.
 *
 * Error assertions check the typed `EditApplyError.reason` discriminator, never
 * message strings (those are already covered, and reasons are the contract the
 * Effect handler maps on).
 */
import { describe, expect, it } from "vitest";

import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	EditApplyError,
	type EditApplyReason,
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../../../effect/tools/edit-diff.js";

const BOM = String.fromCharCode(0xfeff);
const SMART_APOS = String.fromCharCode(0x2019);
const SMART_LDQUO = String.fromCharCode(0x201c);
const SMART_RDQUO = String.fromCharCode(0x201d);
const EM_DASH = String.fromCharCode(0x2014);
const NBSP = String.fromCharCode(0xa0);

/** Run `fn`, assert it threw an `EditApplyError`, and return its reason. */
function reasonOf(fn: () => unknown): EditApplyReason {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(EditApplyError);
		return (e as EditApplyError).reason;
	}
	throw new Error("expected applyEditsToNormalizedContent to throw");
}

describe("fuzzyFindText — exact vs fuzzy boundary", () => {
	it("prefers an exact match even when a fuzzy one would also exist", () => {
		// `it's` appears exactly; index/length describe the ORIGINAL content and
		// fuzzy normalisation is never consulted.
		const content = `keep it as it's written`;
		const result = fuzzyFindText(content, "it's");
		expect(result.usedFuzzyMatch).toBe(false);
		expect(result.index).toBe(content.indexOf("it's"));
		expect(result.matchLength).toBe(4);
		expect(result.contentForReplacement).toBe(content);
	});

	it("fuzzy match reports index/length in NORMALISED space and returns the normalised content", () => {
		// Source line carries trailing spaces; the search omits them. The match
		// must be found, and crucially index+matchLength must address
		// `contentForReplacement` (the normalised content), not the original.
		// A leading `head\n` makes the match start at a NON-ZERO offset, so a
		// mutation that returns 0 (or the original-space index, which is -1 since
		// the exact form is absent) is caught.
		const content = "head\naaa   \nXYZ\ntail";
		const result = fuzzyFindText(content, "aaa\nXYZ");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
		const normalised = normalizeForFuzzyMatch(content);
		expect(result.contentForReplacement).toBe(normalised);
		expect(result.index).toBe(normalised.indexOf("aaa\nXYZ"));
		expect(result.index).toBeGreaterThan(0);
		expect(content.indexOf("aaa\nXYZ")).toBe(-1); // exact form absent in original
		expect(result.matchLength).toBe("aaa\nXYZ".length);
		expect(result.contentForReplacement.substring(result.index, result.index + result.matchLength)).toBe("aaa\nXYZ");
	});

	it("returns a not-found result that still echoes the original content untouched", () => {
		const result = fuzzyFindText("present", "absent");
		expect(result).toEqual({
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: "present",
		});
	});
});

describe("applyEditsToNormalizedContent — exact replacement", () => {
	it("replaces a unique exact occurrence and reports the unmodified base", () => {
		const result = applyEditsToNormalizedContent("const a = 1;\n", [{ oldText: "1", newText: "2" }], "f.ts");
		expect(result.baseContent).toBe("const a = 1;\n");
		expect(result.newContent).toBe("const a = 2;\n");
	});

	it("does not re-match a replacement that itself contains the search text", () => {
		// `foo` -> `foofoo` must terminate after exactly one substitution, not
		// loop on the freshly-inserted `foo`s.
		const result = applyEditsToNormalizedContent("foo", [{ oldText: "foo", newText: "foofoo" }], "f.ts");
		expect(result.newContent).toBe("foofoo");
	});

	it("replacing with a strict superset of the old text yields exactly one expansion", () => {
		const result = applyEditsToNormalizedContent(
			"wrap(value)",
			[{ oldText: "value", newText: "wrap(value)" }],
			"f.ts",
		);
		expect(result.newContent).toBe("wrap(wrap(value))");
	});
});

describe("applyEditsToNormalizedContent — fuzzy (whitespace-insensitive) replacement", () => {
	it("matches across trailing-whitespace differences but rewrites ONLY the matched span", () => {
		// The search spans a line that carries trailing whitespace in the source
		// but not in the query, so an exact match is impossible and the fuzzy
		// path engages. A fuzzy edit must rewrite ONLY its matched span; the rest
		// of the file stays byte-for-byte intact. `baseContent` is the original
		// content (unmodified) and the UNRELATED `keep   ` line keeps its trailing
		// whitespace — the previous lossy whole-file normalisation is gone.
		const content = "alpha   \ntarget\nkeep   \nomega";
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "alpha\ntarget", newText: "ALPHA\nTARGET" }],
			"f.ts",
		);
		expect(result.baseContent).toBe(content);
		expect(result.newContent).toBe("ALPHA\nTARGET\nkeep   \nomega");
	});

	it("matches text whose smart punctuation differs from the source under NFKC folding", () => {
		// Source uses smart quotes / em dash / NBSP; the search uses ASCII.
		const content = `note: ${SMART_LDQUO}done${SMART_RDQUO}${EM_DASH}fully${NBSP}ok`;
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: `"done"-fully ok`, newText: "REPLACED" }],
			"f.ts",
		);
		expect(result.newContent).toBe("note: REPLACED");
	});
});

describe("applyEditsToNormalizedContent — ambiguity and no-match reasons", () => {
	it("reports ambiguous-match when the exact text occurs more than once", () => {
		expect(reasonOf(() => applyEditsToNormalizedContent("x x x", [{ oldText: "x", newText: "y" }], "f.ts"))).toBe(
			"ambiguous-match",
		);
	});

	it("replaces the unique EXACT occurrence even when a second collides only under fuzzy folding", () => {
		// `can't` (ASCII apostrophe) is UNIQUE in its exact byte form; the second
		// `can’t` uses a smart apostrophe and is only equal after NFKC folding.
		// Occurrence counting happens in EXACT-byte space because an exact match
		// exists, so the edit is NOT rejected as ambiguous — it cleanly replaces
		// the single exact occurrence and leaves the smart-apostrophe one intact.
		const content = `can't here, and can${SMART_APOS}t there`;
		const result = applyEditsToNormalizedContent(content, [{ oldText: "can't", newText: "DONE" }], "f.ts");
		expect(result.baseContent).toBe(content);
		expect(result.newContent).toBe(`DONE here, and can${SMART_APOS}t there`);
	});

	it("replaces the unique EXACT occurrence even when a second collides only after trailing-ws trimming", () => {
		// `row\n` is UNIQUE in its exact byte form — the first line is `row  \n`
		// (trailing spaces), so `content.indexOf("row\n")` finds only the second
		// line and an exact (usedFuzzyMatch=false) match results. Because the match
		// is exact, occurrences are counted in exact-byte space (1 hit), so the
		// edit is unambiguous and replaces the second line cleanly. The first line
		// (`row  `) keeps its trailing whitespace byte-for-byte.
		const content = "row  \nrow\n";
		expect(content.split("row\n").length - 1).toBe(1); // exact-form uniqueness precondition
		const result = applyEditsToNormalizedContent(content, [{ oldText: "row\n", newText: "Z\n" }], "f.ts");
		expect(result.newContent).toBe("row  \nZ\n");
	});

	it("reports no-match when nothing matches even fuzzily, including against an empty file", () => {
		expect(reasonOf(() => applyEditsToNormalizedContent("", [{ oldText: "x", newText: "y" }], "f.ts"))).toBe(
			"no-match",
		);
		expect(reasonOf(() => applyEditsToNormalizedContent("hello", [{ oldText: "world", newText: "z" }], "f.ts"))).toBe(
			"no-match",
		);
	});

	it("reports no-match for a whitespace-only oldText that has no exact match and folds to empty", () => {
		// `   ` is non-empty (so it passes the empty-oldText guard) but has no exact
		// occurrence in `abc`, so the fuzzy path runs. Per-line trimEnd folds it to
		// the empty string; matching empty text is meaningless, so it is reported as
		// no-match rather than spuriously matching at offset 0.
		expect(reasonOf(() => applyEditsToNormalizedContent("abc", [{ oldText: "   ", newText: "x" }], "f.ts"))).toBe(
			"no-match",
		);
	});
});

describe("applyEditsToNormalizedContent — fuzzy edge branches", () => {
	it("reports no-match for a whitespace-only oldText that folds to empty under fuzzy normalisation", () => {
		expect(reasonOf(() => applyEditsToNormalizedContent("abc", [{ oldText: "   ", newText: "X" }], "f.ts"))).toBe(
			"no-match",
		);
	});

	it("reports ambiguous-match when occurrences are equal ONLY under fuzzy folding (no exact hit)", () => {
		const content = `${SMART_LDQUO}q${SMART_RDQUO} and ${SMART_LDQUO}q${SMART_RDQUO}`;
		expect(reasonOf(() => applyEditsToNormalizedContent(content, [{ oldText: `"q"`, newText: "Z" }], "f.ts"))).toBe(
			"ambiguous-match",
		);
	});

	it("maps a fuzzy match spanning a multi-character NFKC expansion back onto the original span", () => {
		const content = `head\n${String.fromCharCode(0xfb01)}x here\ntail   `;
		const result = applyEditsToNormalizedContent(content, [{ oldText: "fix here", newText: "DONE" }], "f.ts");
		expect(result.baseContent).toBe(content);
		expect(result.newContent).toBe("head\nDONE\ntail   ");
	});
});

describe("applyEditsToNormalizedContent — empty / no-change boundaries", () => {
	it("rejects an empty oldText before attempting any match", () => {
		expect(reasonOf(() => applyEditsToNormalizedContent("anything", [{ oldText: "", newText: "x" }], "f.ts"))).toBe(
			"empty-old-text",
		);
	});

	it("rejects an empty oldText even when the file itself is empty", () => {
		expect(reasonOf(() => applyEditsToNormalizedContent("", [{ oldText: "", newText: "x" }], "f.ts"))).toBe(
			"empty-old-text",
		);
	});

	it("reports no-change when an exact match replaces text with itself", () => {
		expect(
			reasonOf(() => applyEditsToNormalizedContent("same", [{ oldText: "same", newText: "same" }], "f.ts")),
		).toBe("no-change");
	});
});

describe("applyEditsToNormalizedContent — multi-edit order, overlap, offset stability", () => {
	it("applies disjoint edits with differently-sized replacements without corrupting offsets", () => {
		// `AAA`->1 char shrink and `CCC`->6 char grow. Reverse-order application
		// keeps the earlier match index valid despite the later edit's size change.
		const result = applyEditsToNormalizedContent(
			"AAA BBB CCC",
			[
				{ oldText: "AAA", newText: "a" },
				{ oldText: "CCC", newText: "cccccc" },
			],
			"f.ts",
		);
		expect(result.newContent).toBe("a BBB cccccc");
	});

	it("is independent of the order edits are supplied in (matches sort by position)", () => {
		const forward = applyEditsToNormalizedContent(
			"one two three",
			[
				{ oldText: "one", newText: "1" },
				{ oldText: "three", newText: "3" },
			],
			"f.ts",
		);
		const reverse = applyEditsToNormalizedContent(
			"one two three",
			[
				{ oldText: "three", newText: "3" },
				{ oldText: "one", newText: "1" },
			],
			"f.ts",
		);
		expect(forward.newContent).toBe("1 two 3");
		expect(reverse.newContent).toBe("1 two 3");
	});

	it("reports overlapping-edits when an edit's match abuts INTO a neighbour's region", () => {
		// `abc` (0..3) and `cde` (2..5) overlap on the shared `c`.
		expect(
			reasonOf(() =>
				applyEditsToNormalizedContent(
					"abcdef",
					[
						{ oldText: "abc", newText: "X" },
						{ oldText: "cde", newText: "Y" },
					],
					"f.ts",
				),
			),
		).toBe("overlapping-edits");
	});

	it("allows two edits that touch at the boundary but do not overlap", () => {
		// `ab` ends at index 2, `cd` starts at index 2 — adjacent, not overlapping.
		const result = applyEditsToNormalizedContent(
			"abcd",
			[
				{ oldText: "ab", newText: "X" },
				{ oldText: "cd", newText: "Y" },
			],
			"f.ts",
		);
		expect(result.newContent).toBe("XY");
	});
});

describe("line-ending + BOM preservation around the pure core", () => {
	it("normalizeToLF collapses CRLF and lone CR; restoreLineEndings is its inverse for CRLF", () => {
		const crlf = "a\r\nb\r\nc";
		const lf = normalizeToLF(crlf);
		expect(lf).toBe("a\nb\nc");
		expect(restoreLineEndings(lf, "\r\n")).toBe(crlf);
		expect(restoreLineEndings(lf, "\n")).toBe(lf);
	});

	it("round-trips a CRLF file through detect -> normalize -> edit -> restore", () => {
		const ending = "\r\n" as const;
		const original = "import x\r\nconst y = 1\r\nexport y\r\n";
		expect(detectLineEnding(original)).toBe(ending);
		const normalized = normalizeToLF(original);
		const { newContent } = applyEditsToNormalizedContent(
			normalized,
			[{ oldText: "const y = 1", newText: "const y = 2" }],
			"f.ts",
		);
		const restored = restoreLineEndings(newContent, ending);
		expect(restored).toBe("import x\r\nconst y = 2\r\nexport y\r\n");
		expect(restored.includes("\r\n")).toBe(true);
		expect(/[^\r]\n/.test(restored)).toBe(false); // no bare LF survived
	});

	it("strips, edits LF-content, and re-prepends a BOM so the BOM stays exactly once at the front", () => {
		const withBom = `${BOM}const a = 1\n`;
		const { bom, text } = stripBom(withBom);
		expect(bom).toBe(BOM);
		const { newContent } = applyEditsToNormalizedContent(text, [{ oldText: "1", newText: "2" }], "f.ts");
		const restored = bom + newContent;
		expect(restored).toBe(`${BOM}const a = 2\n`);
		expect(restored.startsWith(BOM)).toBe(true);
		expect(restored.slice(1).includes(BOM)).toBe(false); // no duplicate / interior BOM
	});

	it("stripBom is a no-op (empty bom) for content without a leading BOM", () => {
		expect(stripBom("plain")).toEqual({ bom: "", text: "plain" });
	});
});

describe("generateDiffString — exact markers and line numbers", () => {
	it("renders a two-hunk change with a compressed interior and correct old/new line numbers", () => {
		const before = Array.from({ length: 15 }, (_, i) => `l${i + 1}`).join("\n");
		const after = before.split("\n");
		after[2] = "CHANGED3";
		after[12] = "CHANGED13";
		const result = generateDiffString(before, after.join("\n"), 2);

		// Exact whole-diff assertion: two hunks, each `-`/`+` carrying the right
		// old/new line number, 2 context lines on each side (width-2 padded), and
		// the 5-line interior (lines 6..10) compressed to a single `...` skip
		// marker with the same width-2 left padding. Any off-by-one in oldLineNum
		// / newLineNum, a dropped compression branch, a wrong marker, or wrong
		// skip-marker padding changes this string.
		expect(result.diff).toBe(
			[
				"  1 l1",
				"  2 l2",
				"- 3 l3",
				"+ 3 CHANGED3",
				"  4 l4",
				"  5 l5",
				"    ...",
				" 11 l11",
				" 12 l12",
				"-13 l13",
				"+13 CHANGED13",
				" 14 l14",
				" 15 l15",
			].join("\n"),
		);
		expect(result.firstChangedLine).toBe(3);
	});

	it("renders an addition-only diff with a + marker on the new line and a space-marker on shifted context", () => {
		const result = generateDiffString("a\nb\nc\n", "a\nb\nNEW\nc\n", 4);
		expect(result.diff).toBe(" 1 a\n 2 b\n+3 NEW\n 3 c");
		expect(result.firstChangedLine).toBe(3);
	});

	it("renders a removal-only diff with a - marker carrying the OLD line number", () => {
		const result = generateDiffString("a\nb\nc\n", "a\nc\n", 4);
		expect(result.diff).toBe(" 1 a\n-2 b\n 3 c");
		expect(result.firstChangedLine).toBe(2);
	});

	it("returns an empty diff and undefined firstChangedLine for identical content", () => {
		const result = generateDiffString("a\nb\nc\n", "a\nb\nc\n", 4);
		expect(result.diff).toBe("");
		expect(result.firstChangedLine).toBeUndefined();
	});

	it("pads line numbers to a stable width across single- and double-digit lines", () => {
		// 12 lines forces width 2; the single-digit context rows must be padded
		// with a leading space so columns align.
		const before = Array.from({ length: 12 }, (_, i) => `n${i + 1}`).join("\n");
		const after = before.split("\n");
		after[11] = "LAST";
		const result = generateDiffString(before, after.join("\n"), 4);
		// Exact: the leading interior (lines 1..7) is skipped to a `...` marker
		// padded into the width-2 column, then the last 4 context rows (8..11)
		// are right-aligned, then the `-`/`+` change at line 12. A width-1 (or
		// unpadded) regression on the single-digit rows or the skip marker breaks
		// this string.
		expect(result.diff).toBe(["    ...", "  8 n8", "  9 n9", " 10 n10", " 11 n11", "-12 n12", "+12 LAST"].join("\n"));
	});
});

describe("generateDiffString + applyEditsToNormalizedContent — end-to-end", () => {
	it("diffs the before/after of a real multi-edit apply", () => {
		const before = "function f() {\n  return 1\n}\n";
		const { newContent } = applyEditsToNormalizedContent(
			before,
			[
				{ oldText: "function f()", newText: "function g()" },
				{ oldText: "return 1", newText: "return 42" },
			],
			"f.ts",
		);
		expect(newContent).toBe("function g() {\n  return 42\n}\n");
		const result = generateDiffString(before, newContent, 4);
		// Diff groups all removals before all additions (diffLines behaviour), so
		// old lines 1-2 print with `-`/old numbers, new lines 1-2 with `+`/new
		// numbers, then the unchanged `}` as space-context at line 3.
		expect(result.diff).toBe(
			["-1 function f() {", "-2   return 1", "+1 function g() {", "+2   return 42", " 3 }"].join("\n"),
		);
		expect(result.firstChangedLine).toBe(1);
	});
});

describe("latency — single edit on a 200k-line normalised content", () => {
	it("applies one exact edit in well under a wall-clock bound and does not scale pathologically", () => {
		const N = 200000;
		const lines = new Array<string>(N);
		for (let i = 0; i < N; i++) lines[i] = `line ${i} of a large source file`;
		lines[N - 1] = "UNIQUE_TARGET_MARKER";
		const content = lines.join("\n");
		expect(content.length).toBeGreaterThan(3_000_000);

		const t0 = performance.now();
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: "UNIQUE_TARGET_MARKER", newText: "REPLACED_MARKER" }],
			"big.ts",
		);
		const elapsed = performance.now() - t0;

		expect(result.newContent.endsWith("REPLACED_MARKER")).toBe(true);
		expect(result.newContent.includes("UNIQUE_TARGET_MARKER")).toBe(false);
		// Observed ~10-20ms locally; a generous ceiling guards against accidental
		// O(n^2) regressions (e.g. per-line re-scanning) while tolerating CI jitter.
		expect(elapsed).toBeLessThan(1500);
	});

	it("a no-match against the same large content (full fuzzy-normalise path) is also bounded", () => {
		const N = 200000;
		const lines = new Array<string>(N);
		for (let i = 0; i < N; i++) lines[i] = `line ${i} of a large source file`;
		const content = lines.join("\n");

		const t0 = performance.now();
		const reason = reasonOf(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "NONEXISTENT_ZZZ", newText: "x" }], "big.ts"),
		);
		const elapsed = performance.now() - t0;

		expect(reason).toBe("no-match");
		expect(elapsed).toBeLessThan(1500);
	});
});
