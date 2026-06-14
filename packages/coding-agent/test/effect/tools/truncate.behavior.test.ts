/**
 * Deep behaviour / edge / latency tests for the Effect-lane output-truncation
 * helpers in `effect/tools/truncate.ts`.
 *
 * These import the pure functions directly (no Effect runtime — the module is
 * dependency-free and synchronous) and assert EXACT outputs. They deliberately
 * target the corners the existing happy-path suite
 * (`test/truncate-utils.test.ts`, against the byte-identical `src/` copy) does
 * NOT exercise:
 *   - exact byte-boundary truncation where multi-byte UTF-8 must not split a
 *     codepoint mid-sequence (2-, 3-, and 4-byte sequences + emoji surrogates)
 *   - the "content is one byte over the limit" vs "exactly at the limit" cliff
 *   - empty input, single line with no trailing newline, CRLF line endings
 *   - the trailing-newline phantom-empty-line accounting
 *   - zero-valued limits (maxLines:0 / maxBytes:0) degenerate paths
 *   - formatSize rounding right at the KB/MB rollover boundary
 *   - a LATENCY assertion: a ~40MB / 500k-line input truncates in bounded
 *     time, proving the head/tail scans short-circuit rather than doing
 *     O(n^2) repeated full-string slicing.
 */
import { describe, expect, it } from "vitest";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../../../effect/tools/truncate.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf-8");

// Multi-byte reference characters by their UTF-8 width.
const TWO_BYTE = "é"; // U+00E9  -> 0xC3 0xA9
const THREE_BYTE = "€"; // U+20AC -> 0xE2 0x82 0xAC
const FOUR_BYTE = "😀"; // U+1F600 -> 0xF0 0x9F 0x98 0x80 (surrogate pair in JS)

/**
 * A truncated UTF-8 string is *valid* iff re-encoding the decoded string yields
 * the same bytes (no U+FFFD replacement chars introduced by a split codepoint).
 */
const isValidUtf8 = (s: string) => !s.includes("�");

describe("truncateHead — byte-boundary cliff (at limit vs one over)", () => {
	it("keeps content whose byte length equals maxBytes exactly (single line, no newline)", () => {
		const r = truncateHead("aaaaa", { maxBytes: 5 });
		expect(r.truncated).toBe(false);
		expect(r.truncatedBy).toBeNull();
		expect(r.content).toBe("aaaaa");
		expect(r.totalBytes).toBe(5);
		expect(r.outputBytes).toBe(5);
		expect(r.firstLineExceedsLimit).toBe(false);
	});

	it("drops a single no-newline line that is exactly one byte over the limit", () => {
		// The only line cannot be split for head truncation, so everything is lost.
		const r = truncateHead("aaaaaa", { maxBytes: 5 });
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.content).toBe("");
		expect(r.outputLines).toBe(0);
		expect(r.outputBytes).toBe(0);
		expect(r.firstLineExceedsLimit).toBe(true);
		expect(r.totalBytes).toBe(6);
	});

	it("counts the newline against the byte budget when admitting the second line", () => {
		// Line 0 = "aaaaa" (5B). Line 1 needs 1B newline + 5B = 6B -> 11B > 7B, rejected.
		const r = truncateHead("aaaaa\nbbbbb\nccccc", { maxBytes: 7 });
		expect(r.content).toBe("aaaaa");
		expect(r.truncatedBy).toBe("bytes");
		expect(r.outputLines).toBe(1);
		expect(r.outputBytes).toBe(5);
	});

	it("admits the second line when the budget covers it including the newline byte", () => {
		// "aaaaa"(5) + "\nb"(2) = 7 bytes -> fits exactly.
		const r = truncateHead("aaaaa\nb\nccccc", { maxBytes: 7 });
		expect(r.content).toBe("aaaaa\nb");
		expect(r.truncatedBy).toBe("bytes");
		expect(r.outputLines).toBe(2);
		expect(r.outputBytes).toBe(7);
	});

	it("admits a first line whose bytes equal maxBytes exactly, then byte-truncates the rest", () => {
		// First line "aaaaa" is *exactly* maxBytes (5). The total (8B) still exceeds
		// the limit, so we pass the early-return guard and reach the
		// `firstLineBytes > maxBytes` check. The first line must be KEPT (the guard
		// is strict `>`, not `>=`); only the following lines are dropped on bytes.
		// This pins the off-by-one: a `>=` mutation would discard everything and set
		// firstLineExceedsLimit=true.
		const r = truncateHead("aaaaa\nbb", { maxBytes: 5 });
		expect(r.content).toBe("aaaaa");
		expect(r.firstLineExceedsLimit).toBe(false);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.outputLines).toBe(1);
		expect(r.outputBytes).toBe(5);
	});
});

describe("truncateHead — multi-byte first line never split", () => {
	it("never emits a partial codepoint: a too-big first line is dropped whole, not sliced", () => {
		// Three 2-byte chars = 6 bytes; limit 5 would split the 3rd char mid-sequence
		// if head truncation sliced bytes. Instead it must drop the whole line.
		const r = truncateHead(TWO_BYTE.repeat(3), { maxBytes: 5 });
		expect(r.content).toBe("");
		expect(r.firstLineExceedsLimit).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(isValidUtf8(r.content)).toBe(true);
		expect(r.totalBytes).toBe(6);
	});

	it("keeps a multi-byte line intact when it fits exactly", () => {
		const r = truncateHead(TWO_BYTE.repeat(3), { maxBytes: 6 });
		expect(r.truncated).toBe(false);
		expect(r.content).toBe(TWO_BYTE.repeat(3));
		expect(bytes(r.content)).toBe(6);
	});
});

describe("truncateHead — line counting / phantom empty line", () => {
	it("counts the empty segment produced by a trailing newline as a real line", () => {
		// "a\nb\n".split("\n") === ["a","b",""] -> 3 lines.
		const full = truncateHead("a\nb\n");
		expect(full.totalLines).toBe(3);
		expect(full.truncated).toBe(false);

		const limited = truncateHead("a\nb\n", { maxLines: 2 });
		expect(limited.truncated).toBe(true);
		expect(limited.truncatedBy).toBe("lines");
		expect(limited.content).toBe("a\nb");
		expect(limited.outputLines).toBe(2);
	});

	it("treats maxLines:0 as 'no lines allowed' and returns empty content", () => {
		const r = truncateHead("a\nb\nc", { maxLines: 0 });
		expect(r.content).toBe("");
		expect(r.outputLines).toBe(0);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("lines");
	});

	it("keeps content when line count equals maxLines exactly and bytes fit", () => {
		const r = truncateHead("a\nb", { maxLines: 2 });
		expect(r.truncated).toBe(false);
		expect(r.content).toBe("a\nb");
	});
});

describe("truncateHead — line endings", () => {
	it("splits only on \\n, leaving carriage returns attached to the line", () => {
		const r = truncateHead("a\r\nb\r\nc", { maxLines: 2 });
		expect(r.content).toBe("a\r\nb\r");
		expect(r.truncatedBy).toBe("lines");
		expect(r.outputLines).toBe(2);
		expect(r.totalLines).toBe(3);
	});
});

describe("truncateHead — empty input", () => {
	it("returns empty content as un-truncated with one (empty) line", () => {
		const r = truncateHead("");
		expect(r.truncated).toBe(false);
		expect(r.truncatedBy).toBeNull();
		expect(r.content).toBe("");
		expect(r.totalLines).toBe(1);
		expect(r.totalBytes).toBe(0);
		expect(r.outputLines).toBe(1);
		expect(r.firstLineExceedsLimit).toBe(false);
	});

	it("treats empty input as fitting even under a zero byte budget", () => {
		const r = truncateHead("", { maxBytes: 0 });
		expect(r.truncated).toBe(false);
		expect(r.content).toBe("");
	});
});

describe("truncateTail — exact byte boundary, multi-byte never split", () => {
	it("returns valid UTF-8 (2-byte chars) and never exceeds the byte limit", () => {
		// "ééé" = 6 bytes; limit 3 lands inside the first surviving char, so the
		// boundary scan skips forward to a codepoint start.
		const r = truncateTail(TWO_BYTE.repeat(3), { maxBytes: 3 });
		expect(r.lastLinePartial).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(isValidUtf8(r.content)).toBe(true);
		expect(bytes(r.content)).toBeLessThanOrEqual(3);
		// Skipping the split byte yields exactly one full 2-byte char.
		expect(r.content).toBe(TWO_BYTE);
		expect(bytes(r.content)).toBe(2);
	});

	it("returns valid UTF-8 for 3-byte sequences without splitting a codepoint", () => {
		// "€€" = 6 bytes; limit 4 would land mid-3-byte-char -> scan forward to start.
		const r = truncateTail(THREE_BYTE.repeat(2), { maxBytes: 4 });
		expect(r.lastLinePartial).toBe(true);
		expect(isValidUtf8(r.content)).toBe(true);
		expect(r.content).toBe(THREE_BYTE);
		expect(bytes(r.content)).toBe(3);
		expect(bytes(r.content)).toBeLessThanOrEqual(4);
	});

	it("keeps a 4-byte emoji whole, never producing a lone surrogate / replacement char", () => {
		// 3 emoji = 12 bytes; limit 6 must not split a 4-byte sequence.
		const r = truncateTail(FOUR_BYTE.repeat(3), { maxBytes: 6 });
		expect(r.lastLinePartial).toBe(true);
		expect(isValidUtf8(r.content)).toBe(true);
		expect(r.content).toBe(FOUR_BYTE);
		expect(bytes(r.content)).toBe(4);
		expect(bytes(r.content)).toBeLessThanOrEqual(6);
		// Decoded as exactly one codepoint (surrogate pair stays intact).
		expect([...r.content]).toHaveLength(1);
	});

	it("keeps a multi-byte line whole when it fits exactly at the limit", () => {
		const r = truncateTail(TWO_BYTE.repeat(3), { maxBytes: 6 });
		expect(r.truncated).toBe(false);
		expect(r.content).toBe(TWO_BYTE.repeat(3));
	});
});

describe("truncateTail — partial last line drops earlier lines", () => {
	it("keeps only the byte-bounded tail of the final line when that line alone is too big", () => {
		// Final line "worldlonglong" (13B) already exceeds the 4B budget, so the
		// earlier "hello" line is discarded entirely and only the last 4 bytes survive.
		const r = truncateTail("hello\nworldlonglong", { maxBytes: 4 });
		expect(r.lastLinePartial).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.content).toBe("long");
		expect(r.outputLines).toBe(1);
		expect(r.outputBytes).toBe(4);
		expect(r.totalLines).toBe(2);
	});

	it("keeps the whole final line (no partial) when it fits the budget exactly", () => {
		const r = truncateTail("aaaaa\nbbbbb", { maxBytes: 5 });
		expect(r.lastLinePartial).toBe(false);
		expect(r.content).toBe("bbbbb");
		expect(r.outputLines).toBe(1);
		expect(r.outputBytes).toBe(5);
		expect(r.truncatedBy).toBe("bytes");
	});

	it("yields empty partial content under a zero byte budget", () => {
		const r = truncateTail("abc", { maxBytes: 0 });
		expect(r.truncated).toBe(true);
		expect(r.lastLinePartial).toBe(true);
		expect(r.content).toBe("");
		expect(r.outputBytes).toBe(0);
		expect(isValidUtf8(r.content)).toBe(true);
	});
});

describe("truncateTail — empty input", () => {
	it("returns empty content as un-truncated", () => {
		const r = truncateTail("");
		expect(r.truncated).toBe(false);
		expect(r.content).toBe("");
		expect(r.totalLines).toBe(1);
		expect(r.lastLinePartial).toBe(false);
		expect(r.firstLineExceedsLimit).toBe(false);
	});
});

describe("truncateLine — char-boundary marker correctness", () => {
	it("does not truncate when length equals maxChars exactly", () => {
		const r = truncateLine("abc", 3);
		expect(r.wasTruncated).toBe(false);
		expect(r.text).toBe("abc");
	});

	it("truncates and appends the exact marker when one char over", () => {
		const r = truncateLine("abcd", 3);
		expect(r.wasTruncated).toBe(true);
		expect(r.text).toBe("abc... [truncated]");
	});

	it("slices by JS string length (code units), not bytes, for multi-byte lines", () => {
		// 10 x "é"; maxChars 3 keeps 3 chars (6 bytes) then marker — proves the
		// length gate is character-based, distinct from the byte-based truncators.
		const r = truncateLine(TWO_BYTE.repeat(10), 3);
		expect(r.wasTruncated).toBe(true);
		expect(r.text).toBe(`${TWO_BYTE.repeat(3)}... [truncated]`);
	});

	it("produces a deterministic total length for an over-limit ASCII line", () => {
		const long = "a".repeat(GREP_MAX_LINE_LENGTH + 100);
		const r = truncateLine(long);
		expect(r.wasTruncated).toBe(true);
		expect(r.text.length).toBe(GREP_MAX_LINE_LENGTH + "... [truncated]".length);
		expect(r.text.endsWith("... [truncated]")).toBe(true);
	});

	it("handles an empty line as un-truncated", () => {
		const r = truncateLine("", 3);
		expect(r.wasTruncated).toBe(false);
		expect(r.text).toBe("");
	});
});

describe("formatSize — rollover boundary correctness", () => {
	it("reports just under 1MB as KB rather than rolling to MB (1024.0KB)", () => {
		// 1MB - 1 byte is < 1024*1024 so it stays in the KB branch, surfacing the
		// slightly surprising "1024.0KB" rather than "1.0MB".
		expect(formatSize(1024 * 1024 - 1)).toBe("1024.0KB");
	});

	it("crosses to MB exactly at 1024*1024", () => {
		expect(formatSize(1024 * 1024)).toBe("1.0MB");
	});

	it("reports the largest sub-KB value in bytes", () => {
		expect(formatSize(1023)).toBe("1023B");
		expect(formatSize(1024)).toBe("1.0KB");
	});

	it("uses the default constants as documented", () => {
		expect(DEFAULT_MAX_LINES).toBe(2000);
		expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
		expect(GREP_MAX_LINE_LENGTH).toBe(500);
	});
});

describe("latency / throughput — bounded, non-pathological scan", () => {
	it("truncates a ~40MB / 500k-line input in bounded time (no O(n^2) re-slicing)", () => {
		// 80-char lines x 500k = ~40MB. A naive per-line full-string slice would be
		// O(n^2) and take seconds-to-minutes; the real impl scans line-by-line and
		// short-circuits once the 50KB byte budget is hit, so it must stay fast.
		const huge = `${"x".repeat(80)}\n`.repeat(500_000);
		expect(huge.length).toBeGreaterThan(40_000_000);

		const t0 = performance.now();
		const r = truncateHead(huge, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		const headMs = performance.now() - t0;

		// Byte budget (50KB) is hit long before the 2000-line budget on 81-byte lines.
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(r.totalLines).toBe(500_001); // trailing newline -> phantom empty line
		// Generous ceiling: observed ~10-20ms; an O(n^2) slice would blow past 2s.
		expect(headMs).toBeLessThan(2000);

		const t1 = performance.now();
		const rt = truncateTail(huge, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		const tailMs = performance.now() - t1;
		expect(rt.truncated).toBe(true);
		expect(rt.truncatedBy).toBe("bytes");
		expect(rt.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(tailMs).toBeLessThan(2000);
	});
});
