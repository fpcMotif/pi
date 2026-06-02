import { afterEach, describe, expect, it } from "vitest";
import {
	getApiProvider,
	getApiProviders,
	registerApiProvider,
	clearApiProviders,
	unregisterApiProviders,
} from "../src/api-registry.js";
import {
	resetApiProviders,
	streamOpenAICodexResponses as lazyStreamOpenAICodexResponses,
	streamOpenAICompletions as lazyStreamOpenAICompletions,
	streamOpenAIResponses as lazyStreamOpenAIResponses,
	streamSimpleOpenAICodexResponses as lazyStreamSimpleOpenAICodexResponses,
	streamSimpleOpenAICompletions as lazyStreamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses as lazyStreamSimpleOpenAIResponses,
} from "../src/providers/register-builtins.js";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "../src/providers/simple-options.js";
import { complete, completeSimple, stream, streamSimple } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, StreamOptions } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";
import { StringEnum } from "../src/utils/typebox-helpers.js";

const sourceId = "registry-stream-options-test";
const customApi = "test-registry-api";
const otherApi = "test-registry-other-api";

afterEach(() => {
	unregisterApiProviders(sourceId);
});

function testModel(api: Api = customApi): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://provider.example.test",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 1,
			output: 2,
			cacheRead: 0.25,
			cacheWrite: 0.5,
		},
		contextWindow: 128_000,
		maxTokens: 64_000,
	};
}

function builtInModel<TApi extends "openai-completions" | "openai-responses" | "openai-codex-responses">(
	api: TApi,
): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		reasoning: true,
		input: ["text"],
		cost: {
			input: 1,
			output: 2,
			cacheRead: 0.25,
			cacheWrite: 0.5,
		},
		contextWindow: 128_000,
		maxTokens: 64_000,
		provider: "missing-provider",
		baseUrl: "https://api.openai.com/v1",
	};
}

function message(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0.000001,
				output: 0.000002,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.000003,
			},
		},
		stopReason: "stop",
		timestamp: 123,
	};
}

function doneStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const result = message(model, text);
	const events = new AssistantMessageEventStream();
	events.push({ type: "done", reason: "stop", message: result });
	return events;
}

describe("API registry and stream dispatch", () => {
	it("registers custom providers, wraps API mismatch checks, and unregisters by source", async () => {
		registerApiProvider(
			{
				api: customApi,
				stream: (model, _context, options?: StreamOptions & { marker?: string }) =>
					doneStream(model, `stream:${options?.marker ?? "none"}`),
				streamSimple: (model, _context, options) => doneStream(model, `simple:${options?.reasoning ?? "none"}`),
			},
			sourceId,
		);
		registerApiProvider(
			{
				api: otherApi,
				stream: (model) => doneStream(model, "other"),
				streamSimple: (model) => doneStream(model, "other-simple"),
			},
			"other-source",
		);

		expect(getApiProviders().map((provider) => provider.api)).toEqual(expect.arrayContaining([customApi, otherApi]));

		const provider = getApiProvider(customApi);
		expect(provider).toBeDefined();
		expect(() => provider?.stream(testModel(otherApi), { messages: [] })).toThrow(
			"Mismatched api: test-registry-other-api expected test-registry-api",
		);
		expect(() => provider?.streamSimple(testModel(otherApi), { messages: [] })).toThrow(
			"Mismatched api: test-registry-other-api expected test-registry-api",
		);

		const response = await complete(testModel(), { messages: [] }, { marker: "routed" });
		expect(response.content).toEqual([{ type: "text", text: "stream:routed" }]);

		const simpleResponse = await completeSimple(testModel(), { messages: [] }, { reasoning: "medium" });
		expect(simpleResponse.content).toEqual([{ type: "text", text: "simple:medium" }]);

		unregisterApiProviders(sourceId);
		expect(getApiProvider(customApi)).toBeUndefined();
		expect(getApiProvider(otherApi)).toBeDefined();
		unregisterApiProviders("other-source");
	});

	it("returns streams directly and reports missing providers through public helpers", async () => {
		const context: Context = { messages: [] };
		registerApiProvider(
			{
				api: customApi,
				stream: (model) => doneStream(model, "direct-stream"),
				streamSimple: (model) => doneStream(model, "direct-simple"),
			},
			sourceId,
		);

		await expect(stream(testModel(), context).result()).resolves.toMatchObject({
			content: [{ type: "text", text: "direct-stream" }],
		});
		await expect(streamSimple(testModel(), context).result()).resolves.toMatchObject({
			content: [{ type: "text", text: "direct-simple" }],
		});
		await expect(complete(testModel("missing-api"), context)).rejects.toThrow(
			"No API provider registered for api: missing-api",
		);
	});

	it("clears custom and built-in providers and restores the built-in registry", () => {
		expect(getApiProvider("openai-responses")).toBeDefined();

		clearApiProviders();
		expect(getApiProviders()).toEqual([]);

		resetApiProviders();
		expect(getApiProvider("openai-responses")).toBeDefined();
	});

	it("lazy-loads built-in providers and surfaces missing credentials through streams", async () => {
		await expect(
			lazyStreamOpenAICompletions(builtInModel("openai-completions"), { messages: [] }).result(),
		).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
		});
		await expect(
			lazyStreamSimpleOpenAICompletions(builtInModel("openai-completions"), { messages: [] }).result(),
		).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "No API key for provider: missing-provider",
		});

		await expect(
			lazyStreamOpenAIResponses(builtInModel("openai-responses"), { messages: [] }).result(),
		).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
		});
		await expect(
			lazyStreamSimpleOpenAIResponses(builtInModel("openai-responses"), { messages: [] }).result(),
		).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "No API key for provider: missing-provider",
		});

		await expect(
			lazyStreamOpenAICodexResponses(builtInModel("openai-codex-responses"), { messages: [] }).result(),
		).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "No API key for provider: missing-provider",
		});
		await expect(
			lazyStreamSimpleOpenAICodexResponses(builtInModel("openai-codex-responses"), { messages: [] }).result(),
		).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "No API key for provider: missing-provider",
		});
	});
});

describe("simple provider options", () => {
	it("builds base stream options without losing callbacks, metadata, or explicit API keys", () => {
		const controller = new AbortController();
		const onPayload = (payload: unknown) => payload;
		const onResponse = () => undefined;

		expect(
			buildBaseOptions(
				testModel(),
				{
					temperature: 0.4,
					apiKey: "option-key",
					signal: controller.signal,
					transport: "websocket",
					cacheRetention: "long",
					sessionId: "session-1",
					headers: { "x-test": "1" },
					onPayload,
					onResponse,
					timeoutMs: 1234,
					maxRetries: 3,
					maxRetryDelayMs: 456,
					metadata: { user_id: "user-1" },
				},
				"override-key",
			),
		).toMatchObject({
			temperature: 0.4,
			maxTokens: 32_000,
			apiKey: "override-key",
			signal: controller.signal,
			transport: "websocket",
			cacheRetention: "long",
			sessionId: "session-1",
			headers: { "x-test": "1" },
			onPayload,
			onResponse,
			timeoutMs: 1234,
			maxRetries: 3,
			maxRetryDelayMs: 456,
			metadata: { user_id: "user-1" },
		});
	});

	it("respects explicit max tokens and omits model defaults when the model has no limit", () => {
		expect(buildBaseOptions(testModel(), { maxTokens: 99 }).maxTokens).toBe(99);
		expect(buildBaseOptions({ ...testModel(), maxTokens: 0 }).maxTokens).toBeUndefined();
	});

	it("clamps unsupported reasoning and adjusts thinking budgets to leave output space", () => {
		expect(clampReasoning("xhigh")).toBe("high");
		expect(clampReasoning("medium")).toBe("medium");
		expect(clampReasoning(undefined)).toBeUndefined();

		expect(adjustMaxTokensForThinking(2_000, 20_000, "medium")).toEqual({
			maxTokens: 10_192,
			thinkingBudget: 8_192,
		});
		expect(adjustMaxTokensForThinking(2_000, 2_500, "high")).toEqual({
			maxTokens: 2_500,
			thinkingBudget: 1_476,
		});
		expect(adjustMaxTokensForThinking(2_000, 4_000, "low", { low: 512 })).toEqual({
			maxTokens: 2_512,
			thinkingBudget: 512,
		});
	});
});

describe("TypeBox helpers", () => {
	it("creates provider-compatible string enum schemas with optional metadata", () => {
		expect(StringEnum(["red", "blue"] as const, { description: "Color", default: "blue" })).toMatchObject({
			type: "string",
			enum: ["red", "blue"],
			description: "Color",
			default: "blue",
		});
		expect(StringEnum(["small"] as const)).toMatchObject({
			type: "string",
			enum: ["small"],
		});
	});
});
