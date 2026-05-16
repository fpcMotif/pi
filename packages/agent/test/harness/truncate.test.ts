import { describe, expect, it } from "vitest";
import { formatSize, truncateHead, truncateLine, truncateTail } from "../../src/harness/utils/truncate.js";

describe("truncation utilities", () => {
	it("formats byte sizes with stable units", () => {
		expect(formatSize(512)).toBe("512B");
		expect(formatSize(1536)).toBe("1.5KB");
		expect(formatSize(2 * 1024 * 1024)).toBe("2.0MB");
	});

	it("returns original content when head limits are not exceeded", () => {
		const result = truncateHead("one\ntwo", { maxLines: 3, maxBytes: 100 });

		expect(result).toMatchObject({
			content: "one\ntwo",
			truncated: false,
			truncatedBy: null,
			totalLines: 2,
			outputLines: 2,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
		});
	});

	it("uses default limits for head truncation", () => {
		const result = truncateHead("one");

		expect(result).toMatchObject({
			content: "one",
			truncated: false,
			maxLines: 2000,
			maxBytes: 50 * 1024,
		});
	});

	it("truncates head output by complete lines", () => {
		const result = truncateHead("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });

		expect(result).toMatchObject({
			content: "one\ntwo",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 3,
			outputLines: 2,
		});
		expect(result.outputBytes).toBe(Buffer.byteLength("one\ntwo", "utf-8"));
	});

	it("truncates head output by bytes without returning partial lines", () => {
		const result = truncateHead("alpha\nbeta\ngamma", { maxLines: 10, maxBytes: 8 });

		expect(result).toMatchObject({
			content: "alpha",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1,
			firstLineExceedsLimit: false,
		});
	});

	it("returns empty head output when the first line exceeds the byte limit", () => {
		const result = truncateHead("abcdef\nsecond", { maxLines: 10, maxBytes: 3 });

		expect(result).toMatchObject({
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 0,
			outputBytes: 0,
			firstLineExceedsLimit: true,
		});
	});

	it("returns original content when tail limits are not exceeded", () => {
		const result = truncateTail("one\ntwo", { maxLines: 3, maxBytes: 100 });

		expect(result).toMatchObject({
			content: "one\ntwo",
			truncated: false,
			truncatedBy: null,
			totalLines: 2,
			outputLines: 2,
			lastLinePartial: false,
		});
	});

	it("truncates tail output by complete lines", () => {
		const result = truncateTail("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });

		expect(result).toMatchObject({
			content: "two\nthree",
			truncated: true,
			truncatedBy: "lines",
			outputLines: 2,
		});
	});

	it("truncates tail output by bytes while preserving complete lines when possible", () => {
		const result = truncateTail("alpha\nbeta\ngamma", { maxLines: 10, maxBytes: 10 });

		expect(result).toMatchObject({
			content: "beta\ngamma",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 2,
			lastLinePartial: false,
		});
	});

	it("keeps a UTF-8-safe partial tail when one line exceeds the byte limit", () => {
		const result = truncateTail("alpha\n😀😀😀", { maxLines: 10, maxBytes: 5 });

		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.outputLines).toBe(1);
		expect(result.lastLinePartial).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(5);
		expect(result.content).not.toContain("�");
	});

	it("truncates single grep-style lines with a marker", () => {
		expect(truncateLine("short", 10)).toEqual({ text: "short", wasTruncated: false });
		expect(truncateLine("0123456789", 4)).toEqual({
			text: "0123... [truncated]",
			wasTruncated: true,
		});
	});
});
