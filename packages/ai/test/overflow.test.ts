import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "../src/types.js";
import { getOverflowPatterns, isContextOverflow } from "../src/utils/overflow.js";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("isContextOverflow", () => {
	it("detects provider overflow error messages", () => {
		const overflowMessages = [
			"prompt is too long: 213462 tokens > 200000 maximum",
			'413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
			"input is too long for requested model",
			"Your input exceeds the context window of this model",
			"The input token count (1196265) exceeds the maximum number of tokens allowed",
			"This model's maximum prompt length is 131072 but the request contains 537812 tokens",
			"Please reduce the length of the messages or completion",
			"This endpoint's maximum context length is 200000 tokens. However, you requested about 300000 tokens",
			"The input (250000 tokens) is longer than the model's context length (200000 tokens).",
			"prompt token count of 300000 exceeds the limit of 200000",
			"the request exceeds the available context size, try increasing it",
			"tokens to keep from the initial prompt is greater than the context length",
			"invalid params, context window exceeds limit",
			"Your request exceeded model token limit: 300000 (requested: 350000)",
			"Prompt contains 300000 tokens (...) too large for model with 200000 maximum context length",
			"model_context_window_exceeded",
			"prompt too long; exceeded max context length by 50000 tokens",
			"context_length_exceeded",
			"too many tokens",
			"token limit exceeded",
			"400 status code (no body)",
			"413 (no body)",
		];

		for (const errorMessage of overflowMessages) {
			expect(isContextOverflow(message({ stopReason: "error", errorMessage }))).toBe(true);
		}
	});

	it("ignores overflow-looking text that matches a non-overflow pattern", () => {
		// "Throttling error:" prefix wins over the /too many tokens/ overflow pattern.
		expect(
			isContextOverflow(
				message({
					stopReason: "error",
					errorMessage: "Throttling error: Too many tokens, please wait before trying again.",
				}),
			),
		).toBe(false);

		expect(
			isContextOverflow(
				message({ stopReason: "error", errorMessage: "Service unavailable: too many tokens upstream" }),
			),
		).toBe(false);

		expect(isContextOverflow(message({ stopReason: "error", errorMessage: "rate limit reached" }))).toBe(false);
		expect(isContextOverflow(message({ stopReason: "error", errorMessage: "429 too many requests" }))).toBe(false);
	});

	it("returns false for error messages that match no overflow pattern", () => {
		expect(isContextOverflow(message({ stopReason: "error", errorMessage: "Internal server error" }))).toBe(false);
	});

	it("returns false for error stopReason without an error message", () => {
		expect(isContextOverflow(message({ stopReason: "error" }))).toBe(false);
	});

	it("returns false for a normal successful stop with no contextWindow", () => {
		expect(isContextOverflow(message({ stopReason: "stop", usage: usage({ input: 500 }) }))).toBe(false);
	});

	it("detects silent overflow when usage.input + cacheRead exceeds the context window", () => {
		const result = isContextOverflow(
			message({ stopReason: "stop", usage: usage({ input: 150_000, cacheRead: 60_000 }) }),
			200_000,
		);
		expect(result).toBe(true);
	});

	it("does not flag a successful stop that stays within the context window", () => {
		expect(
			isContextOverflow(
				message({ stopReason: "stop", usage: usage({ input: 100_000, cacheRead: 50_000 }) }),
				200_000,
			),
		).toBe(false);
	});

	it("detects length-stop overflow when input fills the context window and output is zero", () => {
		const result = isContextOverflow(
			message({ stopReason: "length", usage: usage({ input: 199_000, cacheRead: 0, output: 0 }) }),
			200_000,
		);
		expect(result).toBe(true);
	});

	it("does not flag a length stop that still produced output", () => {
		expect(
			isContextOverflow(message({ stopReason: "length", usage: usage({ input: 199_000, output: 10 }) }), 200_000),
		).toBe(false);
	});

	it("does not flag a length stop with zero output but input well below the window", () => {
		expect(
			isContextOverflow(message({ stopReason: "length", usage: usage({ input: 50_000, output: 0 }) }), 200_000),
		).toBe(false);
	});

	it("does not apply silent/length detection when contextWindow is omitted", () => {
		expect(isContextOverflow(message({ stopReason: "stop", usage: usage({ input: 9_999_999 }) }))).toBe(false);
		expect(isContextOverflow(message({ stopReason: "length", usage: usage({ input: 9_999_999, output: 0 }) }))).toBe(
			false,
		);
	});
});

describe("getOverflowPatterns", () => {
	it("returns a defensive copy of the overflow regex list", () => {
		const first = getOverflowPatterns();
		const second = getOverflowPatterns();

		expect(first.length).toBeGreaterThan(0);
		expect(first).not.toBe(second);
		expect(first.every((p) => p instanceof RegExp)).toBe(true);

		first.push(/injected/);
		expect(getOverflowPatterns().some((p) => p.source === "injected")).toBe(false);
	});
});
