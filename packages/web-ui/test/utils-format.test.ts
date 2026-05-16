// ADR-0017 phase C.7: first pi-web-ui tests. Starting with pure-function
// utilities (no DOM, no Lit). format.ts is 42 lines of formatting helpers.
import { describe, expect, it, vi } from "vitest";

// i18n is imported from "@mariozechner/mini-lit" — mock it inline since
// the package may not load cleanly under happy-dom in a node test runner.
vi.mock("@mariozechner/mini-lit", () => ({
	i18n: (s: string) => s,
}));

import { formatCost, formatModelCost, formatTokenCount, formatUsage } from "../src/utils/format.js";

describe("formatCost", () => {
	it("formats with 4 decimal places and a $ prefix", () => {
		expect(formatCost(1.23)).toBe("$1.2300");
		expect(formatCost(0)).toBe("$0.0000");
		expect(formatCost(0.001)).toBe("$0.0010");
		expect(formatCost(999.99999)).toBe("$1000.0000");
	});
});

describe("formatModelCost", () => {
	it("returns 'Free' when cost is null / undefined / falsy", () => {
		expect(formatModelCost(null)).toBe("Free");
		expect(formatModelCost(undefined)).toBe("Free");
		expect(formatModelCost(0)).toBe("Free");
	});

	it("returns 'Free' when both input and output costs are zero", () => {
		expect(formatModelCost({ input: 0, output: 0 })).toBe("Free");
	});

	it("formats large per-million costs as integers (≥100)", () => {
		expect(formatModelCost({ input: 150, output: 250 })).toBe("$150/$250");
	});

	it("formats medium per-million costs with 1 decimal (10-100), stripping trailing .0", () => {
		expect(formatModelCost({ input: 25, output: 50.5 })).toBe("$25/$50.5");
	});

	it("formats small per-million costs with 2 decimals (1-10), stripping trailing zeros", () => {
		expect(formatModelCost({ input: 3, output: 7.25 })).toBe("$3/$7.25");
	});

	it("formats sub-$1 costs with 3 decimals, stripping trailing zeros", () => {
		expect(formatModelCost({ input: 0.5, output: 0.005 })).toBe("$0.5/$0.005");
	});

	it("uses 0 when input or output is missing", () => {
		expect(formatModelCost({ input: 5 })).toContain("$5");
		expect(formatModelCost({ output: 10 })).toContain("/$10");
	});
});

describe("formatTokenCount", () => {
	it("returns raw count for under 1000", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(1)).toBe("1");
		expect(formatTokenCount(999)).toBe("999");
	});

	it("formats 1000-9999 with one decimal kilo (e.g., 1.2k)", () => {
		expect(formatTokenCount(1000)).toBe("1.0k");
		expect(formatTokenCount(1234)).toBe("1.2k");
		expect(formatTokenCount(9999)).toBe("10.0k");
	});

	it("formats ≥10000 as rounded kilo without decimals", () => {
		expect(formatTokenCount(10000)).toBe("10k");
		expect(formatTokenCount(12345)).toBe("12k");
		expect(formatTokenCount(1500000)).toBe("1500k");
	});
});

describe("formatUsage", () => {
	it("returns '' when usage is null / undefined", () => {
		// formatUsage with falsy input → returns "".
		expect(formatUsage(null as never)).toBe("");
		expect(formatUsage(undefined as never)).toBe("");
	});

	it("returns concatenated arrows for non-zero token categories", () => {
		const usage = {
			input: 100,
			output: 50,
			cacheRead: 20,
			cacheWrite: 10,
			totalTokens: 180,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const out = formatUsage(usage);
		expect(out).toContain("↑100");
		expect(out).toContain("↓50");
		expect(out).toContain("R20");
		expect(out).toContain("W10");
	});

	it("appends cost when total > 0", () => {
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		expect(formatUsage(usage)).toContain("$0.3000");
	});

	it("omits zero-valued categories", () => {
		const usage = {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const out = formatUsage(usage);
		expect(out).toContain("↑100");
		expect(out).not.toContain("↓");
		expect(out).not.toContain("R");
		expect(out).not.toContain("W");
		expect(out).not.toContain("$");
	});
});
