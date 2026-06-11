import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../../src/harness/utils/truncate.js";

// These tests target behavior the existing truncate.test.ts does NOT cover:
// exact byte-boundary math, off-by-one at the limit, empty input, single
// no-newline lines, char-vs-byte gate mismatches, multi-byte codepoint
// integrity, the [truncated] marker text, and large-input latency.

const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

describe("truncate — formatSize unit boundaries", () => {
	it("switches units at the exact 1024 / 1MiB boundaries (off-by-one)", () => {
		// 1023 stays in bytes; 1024 flips to KB; the MB flip is at 1024*1024.
		expect(formatSize(1023)).toBe("1023B");
		expect(formatSize(1024)).toBe("1.0KB");
		expect(formatSize(1024 * 1024 - 1)).toBe("1024.0KB");
		expect(formatSize(1024 * 1024)).toBe("1.0MB");
	});

	it("formats zero bytes as plain bytes, not 0.0KB", () => {
		expect(formatSize(0)).toBe("0B");
	});
});

describe("truncate — empty input", () => {
	it("treats empty string as one (empty) line and never truncates", () => {
		// "".split("\n") === [""], so totalLines is 1, not 0.
		const head = truncateHead("", { maxLines: 10, maxBytes: 10 });
		expect(head).toEqual({
			content: "",
			truncated: false,
			truncatedBy: null,
			totalLines: 1,
			totalBytes: 0,
			outputLines: 1,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines: 10,
			maxBytes: 10,
		});

		const tail = truncateTail("", { maxLines: 10, maxBytes: 10 });
		expect(tail).toEqual({
			content: "",
			truncated: false,
			truncatedBy: null,
			totalLines: 1,
			totalBytes: 0,
			outputLines: 1,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines: 10,
			maxBytes: 10,
		});
	});
});

describe("truncateHead — exact byte/line boundaries (off-by-one)", () => {
	it("does NOT truncate when total bytes equal the limit exactly", () => {
		// "a\nb\nc" is exactly 5 bytes.
		const result = truncateHead("a\nb\nc", { maxLines: 100, maxBytes: 5 });
		expect(result.truncated).toBe(false);
		expect(result.truncatedBy).toBe(null);
		expect(result.content).toBe("a\nb\nc");
		expect(result.totalBytes).toBe(5);
	});

	it("truncates by bytes when total is exactly one byte over the limit", () => {
		const result = truncateHead("a\nb\nc", { maxLines: 100, maxBytes: 4 });
		expect(result).toMatchObject({
			content: "a\nb",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 3,
			totalBytes: 5,
			outputLines: 2,
			outputBytes: 3,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
		});
	});

	it("does NOT truncate when line count equals the limit exactly", () => {
		const result = truncateHead("a\nb\nc", { maxLines: 3, maxBytes: 100 });
		expect(result.truncated).toBe(false);
		expect(result.content).toBe("a\nb\nc");
		expect(result.outputLines).toBe(3);
	});

	it("truncates by lines when one line over the line limit (byte limit slack)", () => {
		const result = truncateHead("a\nb\nc\nd", { maxLines: 3, maxBytes: 100 });
		expect(result).toMatchObject({
			content: "a\nb\nc",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 4,
			outputLines: 3,
		});
	});

	it("attributes truncation to bytes when the byte limit is hit before the line limit", () => {
		// 4 lines, 11 bytes; byte budget 5 fits "aa\nbb" (2+1+2). Line limit (100) never reached.
		const result = truncateHead("aa\nbb\ncc\ndd", { maxLines: 100, maxBytes: 5 });
		expect(result).toMatchObject({
			content: "aa\nbb",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 2,
			outputBytes: 5,
		});
	});
});

describe("truncateHead — single line with no newline exceeding the limit", () => {
	it("returns the whole line untouched when it equals the byte limit exactly", () => {
		const result = truncateHead("hello", { maxLines: 10, maxBytes: 5 });
		expect(result.truncated).toBe(false);
		expect(result.content).toBe("hello");
		expect(result.firstLineExceedsLimit).toBe(false);
	});

	it("returns empty content and flags firstLineExceedsLimit one byte over", () => {
		const result = truncateHead("hello", { maxLines: 10, maxBytes: 4 });
		expect(result).toMatchObject({
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 1,
			totalBytes: 5,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
		});
	});
});

describe("truncateHead — multi-byte codepoint integrity at byte boundary", () => {
	it("keeps a whole multi-byte first line that fits exactly in bytes", () => {
		// "café" is 5 bytes (é = 2 bytes); content has a 2nd line that doesn't fit.
		expect(bytes("café")).toBe(5);
		const result = truncateHead("café\nsecond", { maxLines: 10, maxBytes: 5 });
		expect(result).toMatchObject({
			content: "café",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2,
			outputLines: 1,
			outputBytes: 5,
			firstLineExceedsLimit: false,
		});
		// Never splits the é into a lone continuation byte.
		expect(result.content).not.toContain("�");
	});

	it("never emits a partial codepoint: a multi-byte first line over the limit yields empty, not a split", () => {
		// "café" is 5 bytes; budget 4 would land mid-é if it sliced bytes.
		const result = truncateHead("café\nsecond", { maxLines: 10, maxBytes: 4 });
		expect(result.content).toBe("");
		expect(result.firstLineExceedsLimit).toBe(true);
		expect(result.outputBytes).toBe(0);
	});
});

describe("truncateHead — char-vs-byte gate mismatch", () => {
	it("a line that passes a generous line gate is still byte-truncated when multiples larger in bytes", () => {
		// 3 emoji = string length 6 (surrogate pairs), 12 bytes. Generous maxLines (10)
		// passes the line gate, but the byte gate (6) drops the whole over-limit line.
		const emoji = "😀😀😀";
		expect(emoji.length).toBe(6);
		expect(bytes(emoji)).toBe(12);

		const result = truncateHead(emoji, { maxLines: 10, maxBytes: 6 });
		expect(result).toMatchObject({
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 1,
			totalBytes: 12,
			outputLines: 0,
			firstLineExceedsLimit: true,
		});
	});

	it("trailing newline produces an extra empty trailing line counted by the line gate", () => {
		// "a\nb\n".split("\n") === ["a","b",""] => 3 lines. maxLines 1 keeps only "a".
		const result = truncateHead("a\nb\n", { maxLines: 1, maxBytes: 100 });
		expect(result).toMatchObject({
			content: "a",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 3,
			outputLines: 1,
		});
	});
});

describe("truncateTail — exact byte boundaries and limit attribution", () => {
	it("keeps two whole lines when they fit the byte budget exactly", () => {
		// "beta\ngamma" = 4+1+5 = 10 bytes.
		const result = truncateTail("alpha\nbeta\ngamma", { maxLines: 10, maxBytes: 10 });
		expect(result).toMatchObject({
			content: "beta\ngamma",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 3,
			outputLines: 2,
			outputBytes: 10,
			lastLinePartial: false,
		});
	});

	it("drops to a single whole line when one byte short of fitting two", () => {
		const result = truncateTail("alpha\nbeta\ngamma", { maxLines: 10, maxBytes: 9 });
		expect(result).toMatchObject({
			content: "gamma",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			outputBytes: 5,
			lastLinePartial: false,
		});
	});

	it("attributes truncation to lines when the line gate trips before the byte gate", () => {
		const result = truncateTail("a\nb\nc\nd", { maxLines: 2, maxBytes: 100 });
		expect(result).toMatchObject({
			content: "c\nd",
			truncated: true,
			truncatedBy: "lines",
			outputLines: 2,
			lastLinePartial: false,
		});
	});

	it("keeps a whole short last line rather than a partial of a long earlier line", () => {
		// Earlier line is huge; only the short last line fits whole — no partial taken.
		const result = truncateTail("xxxxxxxx\nshort", { maxLines: 10, maxBytes: 5 });
		expect(result).toMatchObject({
			content: "short",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			lastLinePartial: false,
		});
	});
});

describe("truncateTail — partial last line preserves UTF-8 codepoints", () => {
	it("takes a UTF-8-safe tail of a single oversized line (no split codepoint)", () => {
		// "hello" tail with budget 4 -> last 4 bytes "ello", flagged partial.
		const result = truncateTail("hello", { maxLines: 10, maxBytes: 4 });
		expect(result).toMatchObject({
			content: "ello",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			outputBytes: 4,
			lastLinePartial: true,
			firstLineExceedsLimit: false,
		});
	});

	it("partials the LAST line (not the first) and drops earlier lines on a multi-line input", () => {
		// Two lines, both alone exceed the budget. The partial must be the END of the
		// LAST line ("hort" from "short"), with the earlier "xxxxxxxx" dropped entirely.
		// A single-line input cannot distinguish "last line" from "only line"; this one can.
		const result = truncateTail("xxxxxxxx\nshort", { maxLines: 10, maxBytes: 4 });
		expect(result).toMatchObject({
			content: "hort",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2,
			outputLines: 1,
			outputBytes: 4,
			lastLinePartial: true,
			firstLineExceedsLimit: false,
		});
		// Must be a suffix of the final line, never of an earlier one.
		expect("short".endsWith(result.content)).toBe(true);
		expect(result.content.startsWith("x")).toBe(false);
	});

	it("advances past a continuation byte so a multi-byte char at the cut is kept whole", () => {
		// "abc😀" is 7 bytes (😀 = 4). Budget 5: a naive last-5-bytes cut would land
		// inside the emoji; the boundary walk must instead yield "c😀" (1 + 4 = 5 bytes).
		expect(bytes("abc😀")).toBe(7);
		const result = truncateTail("abc😀", { maxLines: 10, maxBytes: 5 });
		expect(result.content).toBe("c😀");
		expect(result.outputBytes).toBe(5);
		expect(result.lastLinePartial).toBe(true);
		expect(result.content).not.toContain("�");
	});

	it("drops a whole multi-byte char rather than split it when the budget lands mid-codepoint", () => {
		// "😀😀😀" is 12 bytes. Budget 7 cannot fit two emoji (8 bytes) and would split
		// the boundary one — so only the last whole emoji (4 bytes) survives.
		const result = truncateTail("😀😀😀", { maxLines: 10, maxBytes: 7 });
		expect(result.content).toBe("😀");
		expect(bytes(result.content)).toBe(4);
		expect(result.outputBytes).toBe(4);
		expect(result.lastLinePartial).toBe(true);
		// No replacement char and no lone surrogate.
		expect(result.content).not.toContain("�");
		expect(result.content.length).toBe(2); // exactly one well-formed surrogate pair
	});
});

describe("truncateLine — marker text and threshold", () => {
	it("returns the line unchanged at exactly the char limit", () => {
		expect(truncateLine("0123456789", 10)).toEqual({ text: "0123456789", wasTruncated: false });
	});

	it("appends the exact '... [truncated]' marker one char over the limit", () => {
		expect(truncateLine("0123456789", 9)).toEqual({
			text: "012345678... [truncated]",
			wasTruncated: true,
		});
	});

	it("uses GREP_MAX_LINE_LENGTH as the default char limit", () => {
		const longLine = "z".repeat(GREP_MAX_LINE_LENGTH + 1);
		const result = truncateLine(longLine);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toBe(`${"z".repeat(GREP_MAX_LINE_LENGTH)}... [truncated]`);
		const exactLine = "z".repeat(GREP_MAX_LINE_LENGTH);
		expect(truncateLine(exactLine)).toEqual({ text: exactLine, wasTruncated: false });
	});

	// A lone surrogate is a high (0xD800–0xDBFF) or low (0xDC00–0xDFFF) code unit
	// that is not part of a well-formed pair — ill-formed UTF-16. Round-tripping
	// through a UTF-8 Buffer replaces any lone surrogate with U+FFFD, so an
	// unchanged round-trip proves there are no broken codepoints.
	const hasLoneSurrogate = (s: string): boolean => Buffer.from(s, "utf-8").toString("utf-8") !== s;

	// FIXED (BUG 3): truncateLine now slices by whole code points (Array.from),
	// so a multi-byte codepoint straddling the char limit is never split into a
	// lone surrogate — it backs off to the last whole code point instead.
	it("backs off to the last whole code point instead of splitting a surrogate pair", () => {
		// 5 emoji, each a 2-code-unit surrogate pair (string length 10). maxChars 3
		// can hold exactly one whole emoji (2 code units); the second emoji (which would
		// push the count to 4) is dropped entirely rather than half-emitted.
		const result = truncateLine("😀😀😀😀😀", 3);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toBe("😀... [truncated]");
		// No LONE surrogate survives: every code unit is part of a well-formed pair.
		expect(hasLoneSurrogate(result.text)).toBe(false);
		expect(result.text).not.toContain("�");
		// The kept emoji is exactly one well-formed surrogate pair (2 code units).
		expect(Array.from(result.text.slice(0, 2))).toEqual(["😀"]);
	});

	it("keeps as many whole code points as fit when the limit lands on a pair boundary", () => {
		// maxChars 4 fits two whole emoji (4 code units) exactly; the third is dropped.
		const result = truncateLine("😀😀😀😀😀", 4);
		expect(result.wasTruncated).toBe(true);
		expect(result.text).toBe("😀😀... [truncated]");
		expect(hasLoneSurrogate(result.text)).toBe(false);
	});
});

describe("truncate — default limit exports", () => {
	it("exposes the documented default limits and applies them when options omitted", () => {
		expect(DEFAULT_MAX_LINES).toBe(2000);
		expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
		expect(GREP_MAX_LINE_LENGTH).toBe(500);

		const head = truncateHead("only one line");
		expect(head.maxLines).toBe(DEFAULT_MAX_LINES);
		expect(head.maxBytes).toBe(DEFAULT_MAX_BYTES);
		expect(head.truncated).toBe(false);

		const tail = truncateTail("only one line");
		expect(tail.maxLines).toBe(DEFAULT_MAX_LINES);
		expect(tail.maxBytes).toBe(DEFAULT_MAX_BYTES);
		expect(tail.truncated).toBe(false);
	});
});

describe("truncate — latency on very large input is bounded (no O(n^2) slicing)", () => {
	it("truncates a ~16MB / 500k-line input quickly and within the byte budget", () => {
		const lineCount = 500_000;
		const big = Array.from({ length: lineCount }, (_, i) => `line ${i} ${"a".repeat(19)}`).join("\n");
		expect(bytes(big)).toBeGreaterThan(10 * 1024 * 1024);

		const startHead = performance.now();
		const head = truncateHead(big, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		const headMs = performance.now() - startHead;

		const startTail = performance.now();
		const tail = truncateTail(big, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		const tailMs = performance.now() - startTail;

		// Correctness on the big input: byte-bounded output, whole lines, accurate totals.
		expect(head.truncated).toBe(true);
		expect(head.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(head.totalLines).toBe(lineCount);
		expect(head.lastLinePartial).toBe(false);

		expect(tail.truncated).toBe(true);
		expect(tail.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(tail.totalLines).toBe(lineCount);

		// Linear, single-pass work over 16MB must stay far below a pathological budget.
		// Empirically ~15ms each; 2000ms is a generous ceiling that still catches an
		// accidental O(n^2) regression (which would run for many seconds / minutes).
		expect(headMs).toBeLessThan(2000);
		expect(tailMs).toBeLessThan(2000);
	});

	it("tail partial-line path on a 10MB single line stays bounded", () => {
		// One 10MB line with no newlines forces the truncateStringToBytesFromEnd path.
		const oneBigLine = "x".repeat(10_000_000);
		const start = performance.now();
		const result = truncateTail(oneBigLine, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		const elapsedMs = performance.now() - start;

		expect(result.lastLinePartial).toBe(true);
		expect(result.outputBytes).toBe(DEFAULT_MAX_BYTES);
		expect(result.outputLines).toBe(1);
		expect(elapsedMs).toBeLessThan(2000);
	});
});
