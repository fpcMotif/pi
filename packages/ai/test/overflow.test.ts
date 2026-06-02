import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import { getOverflowPatterns, isContextOverflow } from "../src/utils/overflow.js";

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

describe("context overflow detection", () => {
	it("detects provider-specific overflow error messages", () => {
		const overflowMessages = [
			"prompt is too long: 213462 tokens > 200000 maximum",
			'413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
			"Input is too long for requested model",
			"Your input exceeds the context window of this model",
			"The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
			"This model's maximum prompt length is 131072 but the request contains 537812 tokens",
			"Please reduce the length of the messages or completion",
			"This endpoint's maximum context length is 8192 tokens. However, you requested about 9000 tokens",
			"The input (9000 tokens) is longer than the model's context length (8192 tokens).",
			"prompt token count of 9000 exceeds the limit of 8192",
			"the request exceeds the available context size, try increasing it",
			"tokens to keep from the initial prompt is greater than the context length",
			"invalid params, context window exceeds limit",
			"Your request exceeded model token limit: 1 (requested: 2)",
			"Prompt contains 9000 tokens and is too large for model with 8192 maximum context length",
			"model_context_window_exceeded",
			"prompt too long; exceeded max context length by 10 tokens",
			"context_length_exceeded",
			"too many tokens",
			"token limit exceeded",
			"413 status code (no body)",
		];

		for (const errorMessage of overflowMessages) {
			expect(isContextOverflow(message({ stopReason: "error", errorMessage }))).toBe(true);
		}
	});

	it("does not misclassify throttling and rate limits as overflow", () => {
		const nonOverflowMessages = [
			"Throttling error: Too many tokens, please wait before trying again.",
			"Service unavailable: too many tokens queued",
			"Rate limit exceeded while counting too many tokens",
			"Too many requests for this account",
		];

		for (const errorMessage of nonOverflowMessages) {
			expect(isContextOverflow(message({ stopReason: "error", errorMessage }))).toBe(false);
		}
	});

	it("detects silent overflow from usage and length-stop truncation signals", () => {
		expect(
			isContextOverflow(
				message({
					usage: {
						input: 90,
						cacheRead: 20,
						output: 1,
						cacheWrite: 0,
						totalTokens: 111,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
				100,
			),
		).toBe(true);

		expect(
			isContextOverflow(
				message({
					stopReason: "length",
					usage: {
						input: 99,
						cacheRead: 0,
						output: 0,
						cacheWrite: 0,
						totalTokens: 99,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
				100,
			),
		).toBe(true);
	});

	it("returns false for non-errors and below-threshold length stops", () => {
		expect(isContextOverflow(message({ stopReason: "error", errorMessage: "upstream exploded" }))).toBe(false);
		expect(isContextOverflow(message({}), 100)).toBe(false);
		expect(
			isContextOverflow(
				message({
					stopReason: "length",
					usage: {
						input: 50,
						cacheRead: 0,
						output: 0,
						cacheWrite: 0,
						totalTokens: 50,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
				100,
			),
		).toBe(false);
	});

	it("returns a defensive copy of overflow patterns", () => {
		const patterns = getOverflowPatterns();
		patterns.pop();
		expect(getOverflowPatterns()).toHaveLength(patterns.length + 1);
	});
});
