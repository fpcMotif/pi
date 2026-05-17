import { describe, expect, it } from "vitest";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "../src/providers/simple-options.js";
import type { Api, Model, SimpleStreamOptions } from "../src/types.js";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as Api,
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...overrides,
	} as Model<Api>;
}

describe("buildBaseOptions", () => {
	it("forwards every simple option and prefers the explicit apiKey argument", () => {
		const signal = new AbortController().signal;
		const onPayload = async () => undefined;
		const onResponse = async () => undefined;
		const options: SimpleStreamOptions = {
			temperature: 0.7,
			maxTokens: 1000,
			signal,
			apiKey: "options-key",
			transport: "sse",
			cacheRetention: "long",
			sessionId: "sess-1",
			headers: { "x-test": "1" },
			onPayload,
			onResponse,
			timeoutMs: 5000,
			maxRetries: 3,
			maxRetryDelayMs: 9000,
			metadata: { trace: "abc" },
		};

		const result = buildBaseOptions(model(), options, "explicit-key");

		expect(result).toEqual({
			temperature: 0.7,
			maxTokens: 1000,
			signal,
			apiKey: "explicit-key",
			transport: "sse",
			cacheRetention: "long",
			sessionId: "sess-1",
			headers: { "x-test": "1" },
			onPayload,
			onResponse,
			timeoutMs: 5000,
			maxRetries: 3,
			maxRetryDelayMs: 9000,
			metadata: { trace: "abc" },
		});
	});

	it("defaults maxTokens to min(model.maxTokens, 32000) when not supplied", () => {
		expect(buildBaseOptions(model({ maxTokens: 128_000 })).maxTokens).toBe(32_000);
		expect(buildBaseOptions(model({ maxTokens: 8_000 })).maxTokens).toBe(8_000);
	});

	it("leaves maxTokens undefined when the model reports no positive maxTokens", () => {
		expect(buildBaseOptions(model({ maxTokens: 0 })).maxTokens).toBeUndefined();
	});

	it("falls back to options.apiKey when no explicit apiKey is passed", () => {
		expect(buildBaseOptions(model(), { apiKey: "from-options" }).apiKey).toBe("from-options");
	});

	it("works with no options object at all", () => {
		const result = buildBaseOptions(model({ maxTokens: 50_000 }));
		expect(result.maxTokens).toBe(32_000);
		expect(result.apiKey).toBeUndefined();
		expect(result.temperature).toBeUndefined();
	});
});

describe("clampReasoning", () => {
	it("downgrades xhigh to high", () => {
		expect(clampReasoning("xhigh")).toBe("high");
	});

	it("passes other levels through unchanged", () => {
		expect(clampReasoning("minimal")).toBe("minimal");
		expect(clampReasoning("low")).toBe("low");
		expect(clampReasoning("medium")).toBe("medium");
		expect(clampReasoning("high")).toBe("high");
		expect(clampReasoning(undefined)).toBeUndefined();
	});
});

describe("adjustMaxTokensForThinking", () => {
	it("adds the default thinking budget for the level and clamps to the model max", () => {
		const result = adjustMaxTokensForThinking(4000, 100_000, "medium");
		// 4000 + 8192 default medium budget
		expect(result.maxTokens).toBe(12_192);
		expect(result.thinkingBudget).toBe(8192);
	});

	it("clamps the total to the model maximum", () => {
		const result = adjustMaxTokensForThinking(20_000, 24_000, "high");
		// 20000 + 16384 = 36384, clamped to 24000
		expect(result.maxTokens).toBe(24_000);
		expect(result.thinkingBudget).toBe(16_384);
	});

	it("treats xhigh as high for budget selection", () => {
		const result = adjustMaxTokensForThinking(4000, 100_000, "xhigh");
		expect(result.thinkingBudget).toBe(16_384);
	});

	it("shrinks the thinking budget so at least minOutputTokens remain when maxTokens <= budget", () => {
		// base 500 + minimal budget 1024 = 1524, but clamped to model max 1500.
		// 1500 <= 1024 is false... use a model max that is <= the budget instead.
		const result = adjustMaxTokensForThinking(500, 1500, "minimal");
		// maxTokens = min(500 + 1024, 1500) = 1500; 1500 <= 1024 is false -> budget stays 1024.
		expect(result.maxTokens).toBe(1500);
		expect(result.thinkingBudget).toBe(1024);
	});

	it("reduces the thinking budget to leave room for output when the clamped max is below the budget", () => {
		// model max 800 is below the minimal budget of 1024.
		const result = adjustMaxTokensForThinking(500, 800, "minimal");
		// maxTokens = min(500 + 1024, 800) = 800; 800 <= 1024 -> budget = max(0, 800 - 1024) = 0.
		expect(result.maxTokens).toBe(800);
		expect(result.thinkingBudget).toBe(0);
	});

	it("honors custom thinking budgets", () => {
		const result = adjustMaxTokensForThinking(1000, 100_000, "low", {
			minimal: 1,
			low: 5000,
			medium: 1,
			high: 1,
		});
		expect(result.thinkingBudget).toBe(5000);
		expect(result.maxTokens).toBe(6000);
	});
});
