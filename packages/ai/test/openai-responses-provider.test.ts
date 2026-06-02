import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model, ProviderResponse } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	events: [] as unknown[],
	lastClientOptions: undefined as unknown,
	lastParams: undefined as unknown,
	lastRequestOptions: undefined as unknown,
	nextError: undefined as unknown,
	responseStatus: 200,
	responseHeaders: [["x-response", "seen"]] as [string, string][],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: unknown, requestOptions: unknown) => {
				mockState.lastParams = params;
				mockState.lastRequestOptions = requestOptions;
				if (mockState.nextError !== undefined) {
					const error = mockState.nextError;
					mockState.nextError = undefined;
					return {
						withResponse: async () => {
							throw error;
						},
					};
				}
				const stream = {
					async *[Symbol.asyncIterator]() {
						for (const event of mockState.events) {
							yield event;
						}
					},
				};
				return {
					withResponse: async () => ({
						data: stream,
						response: {
							status: mockState.responseStatus,
							headers: new Headers(mockState.responseHeaders),
						},
					}),
				};
			},
		};

		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

afterEach(() => {
	mockState.events = [];
	mockState.lastClientOptions = undefined;
	mockState.lastParams = undefined;
	mockState.lastRequestOptions = undefined;
	mockState.nextError = undefined;
	mockState.responseStatus = 200;
	mockState.responseHeaders = [["x-response", "seen"]];
});

function responsesModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-5.5",
		name: "GPT 5.5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 10,
			output: 20,
			cacheRead: 2,
			cacheWrite: 4,
		},
		contextWindow: 400_000,
		maxTokens: 128_000,
		headers: { "x-model": "base" },
		...overrides,
	};
}

function context(): Context {
	return {
		systemPrompt: "Be precise.",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [
			{
				name: "echo",
				description: "Echo text",
				parameters: {
					type: "object",
					properties: {
						text: { type: "string" },
					},
					required: ["text"],
				},
			},
		],
	};
}

function completedTextEvents(text: string, serviceTier: "flex" | "priority" | "default" | undefined): unknown[] {
	return [
		{
			type: "response.created",
			response: { id: "resp_1" },
			sequence_number: 1,
		},
		{
			type: "response.output_item.added",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "in_progress",
				content: [],
			},
			output_index: 0,
			sequence_number: 2,
		},
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
			sequence_number: 3,
		},
		{
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: text,
			logprobs: [],
			sequence_number: 4,
		},
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
			output_index: 0,
			sequence_number: 5,
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				service_tier: serviceTier,
				usage: {
					input_tokens: 10,
					output_tokens: 4,
					total_tokens: 14,
					input_tokens_details: { cached_tokens: 3 },
				},
			},
			sequence_number: 6,
		},
	];
}

describe("openai-responses provider", () => {
	it("builds request params, forwards response metadata, and applies service-tier pricing", async () => {
		mockState.events = completedTextEvents("hello", "priority");
		const controller = new AbortController();
		const responses: ProviderResponse[] = [];

		const result = await streamOpenAIResponses(responsesModel(), context(), {
			apiKey: "test-key",
			cacheRetention: "long",
			sessionId: "session-1",
			headers: { "x-user": "override" },
			maxTokens: 123,
			temperature: 0.25,
			serviceTier: "priority",
			reasoningEffort: "high",
			reasoningSummary: "concise",
			timeoutMs: 1_000,
			maxRetries: 4,
			signal: controller.signal,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), metadata: { patched: true } }),
			onResponse: (response) => {
				responses.push(response);
			},
		}).result();

		expect(result.content).toEqual([{ type: "text", text: "hello", textSignature: '{"v":1,"id":"msg_1"}' }]);
		expect(result.responseId).toBe("resp_1");
		expect(result.usage).toMatchObject({
			input: 7,
			output: 4,
			cacheRead: 3,
			totalTokens: 14,
		});
		expect(result.usage.cost.total).toBeCloseTo(0.00039);
		expect(responses).toEqual([{ status: 200, headers: { "x-response": "seen" } }]);
		expect(mockState.lastClientOptions).toMatchObject({
			apiKey: "test-key",
			baseURL: "https://api.example.test/v1",
			defaultHeaders: {
				"x-model": "base",
				"x-user": "override",
				session_id: "session-1",
				"x-client-request-id": "session-1",
			},
		});
		expect(mockState.lastRequestOptions).toMatchObject({
			signal: controller.signal,
			timeout: 1_000,
			maxRetries: 4,
		});
		expect(mockState.lastParams).toMatchObject({
			model: "gpt-5.5",
			stream: true,
			store: false,
			max_output_tokens: 123,
			temperature: 0.25,
			service_tier: "priority",
			prompt_cache_key: "session-1",
			prompt_cache_retention: "24h",
			metadata: { patched: true },
			reasoning: {
				effort: "high",
				summary: "concise",
			},
			include: ["reasoning.encrypted_content"],
			tools: [
				{
					type: "function",
					name: "echo",
					description: "Echo text",
					strict: false,
				},
			],
		});
	});

	it("honors compat flags for cache headers and long retention", async () => {
		mockState.events = completedTextEvents("compat", undefined);

		await streamOpenAIResponses(
			responsesModel({
				compat: {
					sendSessionIdHeader: false,
					supportsLongCacheRetention: false,
				},
			}),
			{ messages: [] },
			{
				apiKey: "test-key",
				cacheRetention: "long",
				sessionId: "session-2",
			},
		).result();

		expect(mockState.lastClientOptions).toMatchObject({
			defaultHeaders: {
				"x-client-request-id": "session-2",
			},
		});
		expect(mockState.lastClientOptions).not.toMatchObject({
			defaultHeaders: {
				session_id: "session-2",
			},
		});
		expect(mockState.lastParams).toMatchObject({
			prompt_cache_key: "session-2",
			prompt_cache_retention: undefined,
		});
	});

	it("omits cache session headers and payload keys when cache retention is none", async () => {
		mockState.events = completedTextEvents("no cache", undefined);

		await streamOpenAIResponses(
			responsesModel(),
			{ messages: [] },
			{
				apiKey: "test-key",
				cacheRetention: "none",
				sessionId: "session-none",
			},
		).result();

		expect(mockState.lastClientOptions).toMatchObject({
			defaultHeaders: { "x-model": "base" },
		});
		expect(mockState.lastParams).toMatchObject({
			prompt_cache_key: undefined,
			prompt_cache_retention: undefined,
		});
	});

	it("uses PI_CACHE_RETENTION and OPENAI_API_KEY fallbacks", async () => {
		const previousRetention = process.env.PI_CACHE_RETENTION;
		const previousKey = process.env.OPENAI_API_KEY;
		process.env.PI_CACHE_RETENTION = "long";
		process.env.OPENAI_API_KEY = "env-key";
		mockState.events = completedTextEvents("env", undefined);

		try {
			await streamOpenAIResponses(
				responsesModel({ provider: "unknown-provider" }),
				{ messages: [] },
				{ sessionId: "session-env" },
			).result();
		} finally {
			if (previousRetention === undefined) {
				delete process.env.PI_CACHE_RETENTION;
			} else {
				process.env.PI_CACHE_RETENTION = previousRetention;
			}
			if (previousKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousKey;
			}
		}

		expect(mockState.lastClientOptions).toMatchObject({ apiKey: "env-key" });
		expect(mockState.lastParams).toMatchObject({
			prompt_cache_key: "session-env",
			prompt_cache_retention: "24h",
		});
	});

	it("defaults reasoning effort when only a summary is requested", async () => {
		mockState.events = completedTextEvents("summary", undefined);

		await streamOpenAIResponses(
			responsesModel(),
			{ messages: [] },
			{
				apiKey: "test-key",
				reasoningSummary: "detailed",
			},
		).result();

		expect(mockState.lastParams).toMatchObject({
			reasoning: {
				effort: "medium",
				summary: "detailed",
			},
		});
	});

	it("maps thinking levels and skips default reasoning for Copilot-compatible models", async () => {
		mockState.events = completedTextEvents("mapped", undefined);

		await streamOpenAIResponses(
			responsesModel({ thinkingLevelMap: { high: "medium", off: "low" } }),
			{ messages: [] },
			{
				apiKey: "test-key",
				reasoningEffort: "high",
			},
		).result();

		expect(mockState.lastParams).toMatchObject({
			reasoning: { effort: "medium", summary: "auto" },
		});

		mockState.events = completedTextEvents("copilot", undefined);
		await streamOpenAIResponses(
			responsesModel({ provider: "github-copilot" }),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();

		expect(mockState.lastParams).not.toHaveProperty("reasoning");
	});

	it("maps simple options to responses options and rejects missing API keys before streaming", async () => {
		expect(() =>
			streamSimpleOpenAIResponses(responsesModel({ provider: "unknown-provider" }), { messages: [] }),
		).toThrow("No API key for provider: unknown-provider");

		mockState.events = completedTextEvents("simple", "flex");
		const result = await streamSimpleOpenAIResponses(
			responsesModel(),
			{ messages: [] },
			{
				apiKey: "test-key",
				reasoning: "xhigh",
				maxTokens: 256,
			},
		).result();

		expect(result.content).toEqual([{ type: "text", text: "simple", textSignature: '{"v":1,"id":"msg_1"}' }]);
		expect(mockState.lastParams).toMatchObject({
			max_output_tokens: 256,
			reasoning: {
				effort: "high",
				summary: "auto",
			},
		});
		expect(result.usage.cost.total).toBeCloseTo(0.000078);

		mockState.events = completedTextEvents("plain simple", "priority");
		const plainSimple = await streamSimpleOpenAIResponses(
			responsesModel({ id: "gpt-4.1" }),
			{ messages: [] },
			{
				apiKey: "test-key",
			},
		).result();

		expect(mockState.lastParams).toMatchObject({
			reasoning: {
				effort: "none",
			},
		});
		expect(plainSimple.usage.cost.total).toBeCloseTo(0.000312);
	});

	it("returns error messages for missing keys and aborted requests through the stream protocol", async () => {
		const missingKey = await streamOpenAIResponses(responsesModel({ provider: "unknown-provider" }), {
			messages: [],
		}).result();
		expect(missingKey.stopReason).toBe("error");
		expect(missingKey.errorMessage).toContain("OpenAI API key is required");

		mockState.events = completedTextEvents("aborted", undefined);
		const controller = new AbortController();
		controller.abort();
		const aborted = await streamOpenAIResponses(
			responsesModel(),
			{ messages: [] },
			{
				apiKey: "test-key",
				signal: controller.signal,
			},
		).result();

		expect(aborted.stopReason).toBe("aborted");
		expect(aborted.errorMessage).toBe("Request was aborted");

		mockState.events = [
			{
				type: "response.completed",
				response: {
					id: "resp_failed",
					status: "failed",
				},
				sequence_number: 1,
			},
		];
		const providerError = await streamOpenAIResponses(
			responsesModel(),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();
		expect(providerError.stopReason).toBe("error");
		expect(providerError.errorMessage).toBe("An unknown error occurred");

		mockState.nextError = { code: "bad_request" };
		const objectFailure = await streamOpenAIResponses(
			responsesModel(),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();
		expect(objectFailure.stopReason).toBe("error");
		expect(objectFailure.errorMessage).toBe('{"code":"bad_request"}');
	});
});
