import { afterEach, describe, expect, it, vi } from "vitest";
import {
	convertMessages,
	streamOpenAICompletions,
	streamSimpleOpenAICompletions,
	type OpenAICompletionsOptions,
} from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, ProviderResponse, SimpleStreamOptions } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
	createError: undefined as unknown,
	lastClientOptions: undefined as unknown,
	lastParams: undefined as unknown,
	lastRequestOptions: undefined as unknown,
	responseStatus: 200,
	responseHeaders: [["x-response", "seen"]] as [string, string][],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown, requestOptions: unknown) => {
					mockState.lastParams = params;
					mockState.lastRequestOptions = requestOptions;
					if (mockState.createError) {
						throw mockState.createError;
					}
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks) {
								yield chunk;
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
			},
		};

		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

afterEach(() => {
	mockState.chunks = [];
	mockState.createError = undefined;
	mockState.lastClientOptions = undefined;
	mockState.lastParams = undefined;
	mockState.lastRequestOptions = undefined;
	mockState.responseStatus = 200;
	mockState.responseHeaders = [["x-response", "seen"]];
});

function completionsModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 10,
			output: 20,
			cacheRead: 2,
			cacheWrite: 4,
		},
		contextWindow: 128_000,
		maxTokens: 64_000,
		headers: { "x-model": "base" },
		...overrides,
	};
}

function context(): Context {
	return {
		systemPrompt: "Be exact.",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", mimeType: "image/png", data: "abcd" },
				],
				timestamp: 1,
			},
		],
		tools: [
			{
				name: "edit",
				description: "Edit a file",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
					},
					required: ["path"],
				},
			},
		],
	};
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function completionsCompat(
	overrides: Partial<Parameters<typeof convertMessages>[2]> = {},
): Parameters<typeof convertMessages>[2] {
	return {
		supportsStore: true,
		supportsDeveloperRole: true,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		maxTokensField: "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: false,
		thinkingFormat: "openai",
		openRouterRouting: {},
		zaiToolStream: false,
		supportsStrictMode: true,
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention: true,
		...overrides,
	};
}

function streamedToolUseChunks(): unknown[] {
	return [
		null,
		{ choices: [] },
		{ choices: {} },
		{
			id: "chatcmpl_1",
			created: 1,
			model: "routed/model",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						content: "answer",
						reasoning_content: "think",
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "edit", arguments: '{"path":' },
							},
						],
						reasoning_details: [{ type: "reasoning.encrypted", id: "call_1", data: "signature" }],
					},
				},
			],
		},
		{
			id: "chatcmpl_1",
			created: 1,
			model: "routed/model",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								function: { arguments: '"README.md"}' },
							},
						],
					},
				},
			],
		},
		{
			id: "chatcmpl_1",
			created: 1,
			model: "routed/model",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 4,
				prompt_tokens_details: {
					cached_tokens: 3,
					cache_write_tokens: 2,
				},
			},
		},
	];
}

function terminalChunk(finishReason: string | null = "stop"): unknown[] {
	return [
		{
			id: "chatcmpl_terminal",
			created: 1,
			model: "gpt-test",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
		},
	];
}

describe("openai-completions provider", () => {
	it("converts replay history for thinking, tool results, and attached tool images", () => {
		const messages = convertMessages(
			completionsModel(),
			{
				systemPrompt: "Policy",
				messages: [
					assistantMessage([
						{ type: "thinking", thinking: "private plan", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "visible" },
						{
							type: "toolCall",
							id: "call_1",
							name: "edit",
							arguments: { path: "README.md" },
							thoughtSignature: '{"type":"reasoning.encrypted","id":"call_1","data":"sig"}',
						},
						{
							type: "toolCall",
							id: "call_2",
							name: "search",
							arguments: { query: "coverage" },
							thoughtSignature: "not-json",
						},
					]),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "edit",
						content: [
							{ type: "text", text: "done" },
							{ type: "image", mimeType: "image/png", data: "abcd" },
						],
						isError: false,
						timestamp: 2,
					},
				],
			},
			completionsCompat({
				requiresAssistantAfterToolResult: true,
				requiresToolResultName: true,
				requiresReasoningContentOnAssistantMessages: true,
			}),
		);

		expect(messages).toEqual([
			{ role: "developer", content: "Policy" },
			{
				role: "assistant",
				content: "visible",
				reasoning_content: "private plan",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "edit", arguments: '{"path":"README.md"}' },
					},
					{
						id: "call_2",
						type: "function",
						function: { name: "search", arguments: '{"query":"coverage"}' },
					},
				],
				reasoning_details: [{ type: "reasoning.encrypted", id: "call_1", data: "sig" }],
			},
			{ role: "tool", content: "done", tool_call_id: "call_1", name: "edit" },
			{ role: "tool", content: "No result provided", tool_call_id: "call_2", name: "search" },
			{
				role: "assistant",
				content: "I have processed the tool results.",
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "Attached image(s) from tool result:" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,abcd" } },
				],
			},
		]);
	});

	it("bridges text-only tool results before the next user turn when required", () => {
		const messages = convertMessages(
			completionsModel({ reasoning: false }),
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "lookup",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: 1,
					},
					{ role: "user", content: "continue", timestamp: 2 },
				],
			},
			completionsCompat({
				supportsDeveloperRole: false,
				requiresAssistantAfterToolResult: true,
			}),
		);

		expect(messages).toEqual([
			{ role: "tool", content: "result", tool_call_id: "call_1" },
			{ role: "assistant", content: "I have processed the tool results." },
			{ role: "user", content: "continue" },
		]);
	});

	it("renders thinking as text and drops empty replay messages", () => {
		const messages = convertMessages(
			completionsModel(),
			{
				messages: [
					assistantMessage([
						{ type: "thinking", thinking: "hidden", thinkingSignature: "" },
						{ type: "text", text: "shown" },
					]),
					assistantMessage([{ type: "text", text: "   " }]),
					{ role: "user", content: [], timestamp: 2 },
				],
			},
			completionsCompat({ requiresThinkingAsText: true }),
		);

		expect(messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hidden" },
					{ type: "text", text: "shown" },
				],
			},
		]);
	});

	it("adds required reasoning placeholders to text-only assistant replay", () => {
		const messages = convertMessages(
			completionsModel(),
			{
				messages: [assistantMessage([{ type: "text", text: "plain answer" }])],
			},
			completionsCompat({ requiresReasoningContentOnAssistantMessages: true }),
		);

		expect(messages).toEqual([{ role: "assistant", content: "plain answer", reasoning_content: "" }]);
	});

	it("normalizes cross-provider tool call identifiers before replay", () => {
		const longId = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
		const pipeId = "bad!call|opaque/provider/id";
		const messages = convertMessages(
			completionsModel(),
			{
				messages: [
					assistantMessage([{ type: "toolCall", id: longId, name: "long", arguments: { ok: true } }], {
						provider: "anthropic",
						model: "claude",
					}),
					{
						role: "toolResult",
						toolCallId: longId,
						toolName: "long",
						content: [{ type: "text", text: "long result" }],
						isError: false,
						timestamp: 2,
					},
					assistantMessage([{ type: "toolCall", id: pipeId, name: "pipe", arguments: { ok: true } }], {
						provider: "anthropic",
						model: "claude",
					}),
					{
						role: "toolResult",
						toolCallId: pipeId,
						toolName: "pipe",
						content: [{ type: "text", text: "pipe result" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			completionsCompat(),
		);

		expect(messages).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
						type: "function",
						function: { name: "long", arguments: '{"ok":true}' },
					},
				],
			},
			{ role: "tool", content: "long result", tool_call_id: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "bad_call",
						type: "function",
						function: { name: "pipe", arguments: '{"ok":true}' },
					},
				],
			},
			{ role: "tool", content: "pipe result", tool_call_id: "bad_call" },
		]);

		const nonOpenAiMessages = convertMessages(
			completionsModel({ provider: "anthropic" }),
			{
				messages: [assistantMessage([{ type: "toolCall", id: longId, name: "long", arguments: { ok: true } }])],
			},
			completionsCompat(),
		);
		expect(nonOpenAiMessages[0]).toMatchObject({
			tool_calls: [{ id: longId }],
		});

		const shortOpenAiMessages = convertMessages(
			completionsModel(),
			{
				messages: [assistantMessage([{ type: "toolCall", id: "short_id", name: "short", arguments: {} }])],
			},
			completionsCompat(),
		);
		expect(shortOpenAiMessages[0]).toMatchObject({
			tool_calls: [{ id: "short_id" }],
		});
	});

	it("uses a text placeholder for image-only tool results on text-only models", () => {
		const messages = convertMessages(
			completionsModel({ input: ["text"] }),
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_img",
						toolName: "screenshot",
						content: [{ type: "image", mimeType: "image/png", data: "abcd" }],
						isError: false,
						timestamp: 1,
					},
				],
			},
			completionsCompat(),
		);

		expect(messages).toEqual([
			{ role: "tool", content: "(tool image omitted: model does not support images)", tool_call_id: "call_img" },
		]);
	});

	it("builds chat params, streams text/thinking/tool calls, and normalizes usage", async () => {
		mockState.chunks = streamedToolUseChunks();
		const controller = new AbortController();
		const responses: ProviderResponse[] = [];

		const result = await streamOpenAICompletions(
			completionsModel({
				compat: {
					cacheControlFormat: "anthropic",
					sendSessionAffinityHeaders: true,
				},
			}),
			context(),
			{
				apiKey: "test-key",
				cacheRetention: "long",
				sessionId: "session-1",
				headers: { "x-user": "override" },
				maxTokens: 123,
				temperature: 0.25,
				toolChoice: "required",
				reasoningEffort: "high",
				timeoutMs: 1_000,
				maxRetries: 4,
				signal: controller.signal,
				onPayload: (payload) => ({ ...(payload as Record<string, unknown>), metadata: { patched: true } }),
				onResponse: (response) => {
					responses.push(response);
				},
			},
		).result();

		expect(result.responseId).toBe("chatcmpl_1");
		expect(result.responseModel).toBe("routed/model");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "think", thinkingSignature: "reasoning_content" },
			{
				type: "toolCall",
				id: "call_1",
				name: "edit",
				arguments: { path: "README.md" },
				thoughtSignature: '{"type":"reasoning.encrypted","id":"call_1","data":"signature"}',
			},
		]);
		expect(result.usage).toMatchObject({
			input: 7,
			output: 4,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 14,
		});
		expect(result.usage.cost.total).toBeCloseTo(0.00016);
		expect(responses).toEqual([{ status: 200, headers: { "x-response": "seen" } }]);
		expect(mockState.lastClientOptions).toMatchObject({
			apiKey: "test-key",
			baseURL: "https://api.openai.com/v1",
			defaultHeaders: {
				"x-model": "base",
				"x-user": "override",
				session_id: "session-1",
				"x-client-request-id": "session-1",
				"x-session-affinity": "session-1",
			},
		});
		expect(mockState.lastRequestOptions).toMatchObject({
			signal: controller.signal,
			timeout: 1_000,
			maxRetries: 4,
		});
		expect(mockState.lastParams).toMatchObject({
			model: "gpt-test",
			stream: true,
			store: false,
			stream_options: { include_usage: true },
			max_completion_tokens: 123,
			temperature: 0.25,
			tool_choice: "required",
			prompt_cache_key: "session-1",
			prompt_cache_retention: "24h",
			reasoning_effort: "high",
			metadata: { patched: true },
			tools: [
				{
					type: "function",
					function: {
						name: "edit",
						description: "Edit a file",
						strict: false,
					},
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
		});
		expect(mockState.lastParams).toMatchObject({
			messages: [
				{
					role: "developer",
					content: [{ type: "text", text: "Be exact.", cache_control: { type: "ephemeral", ttl: "1h" } }],
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
						{ type: "image_url", image_url: { url: "data:image/png;base64,abcd" } },
					],
				},
			],
		});
	});

	it("streams tool-call metadata that arrives after the first delta", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl_tool_patch",
				created: 1,
				model: "gpt-test",
				object: "chat.completion.chunk",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ id: "call_late_index", type: "function", function: { name: "edit", arguments: '{"path":' } },
								{ index: 1, type: "function", function: { arguments: '{"query":' } },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl_tool_patch",
				created: 1,
				model: "gpt-test",
				object: "chat.completion.chunk",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: "call_late_index", function: { arguments: '"README.md"}' } },
								{ index: 1, id: "call_late_name", function: { name: "search", arguments: '"docs"}' } },
							],
						},
					},
				],
			},
			{
				id: "chatcmpl_tool_patch",
				created: 1,
				model: "gpt-test",
				object: "chat.completion.chunk",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			},
		];

		const result = await streamOpenAICompletions(
			completionsModel(),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();

		expect(result.content).toEqual([
			{ type: "toolCall", id: "call_late_index", name: "edit", arguments: { path: "README.md" } },
			{ type: "toolCall", id: "call_late_name", name: "search", arguments: { query: "docs" } },
		]);
	});

	it("uses tool-history placeholders and environment API keys when no key is passed", async () => {
		const previousKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "env-key";
		mockState.chunks = terminalChunk();

		try {
			await streamOpenAICompletions(
				completionsModel({ provider: "unknown-provider" }),
				{
					messages: [
						{
							role: "toolResult",
							toolCallId: "call_1",
							toolName: "lookup",
							content: [{ type: "text", text: "result" }],
							isError: false,
							timestamp: 1,
						},
					],
				},
				{ cacheRetention: "short" },
			).result();
		} finally {
			if (previousKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousKey;
			}
		}

		expect(mockState.lastClientOptions).toMatchObject({ apiKey: "env-key" });
		expect(mockState.lastParams).toMatchObject({ tools: [] });
	});

	it("maps compatibility options for nonstandard providers", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl_2",
				created: 1,
				model: "zai-model",
				object: "chat.completion.chunk",
				choices: [
					{
						index: 0,
						delta: { reasoning: "hidden" },
						usage: {
							prompt_tokens: 2,
							completion_tokens: 1,
							prompt_cache_hit_tokens: 1,
						},
					},
				],
			},
			{
				id: "chatcmpl_2",
				created: 1,
				model: "zai-model",
				object: "chat.completion.chunk",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		];

		const result = await streamOpenAICompletions(
			completionsModel({
				provider: "zai",
				baseUrl: "https://api.z.ai/v1",
				compat: {
					zaiToolStream: true,
					sendSessionAffinityHeaders: true,
					supportsUsageInStreaming: false,
					supportsStore: false,
					supportsStrictMode: false,
					supportsLongCacheRetention: false,
					maxTokensField: "max_tokens",
					thinkingFormat: "zai",
				},
			}),
			context(),
			{
				apiKey: "test-key",
				cacheRetention: "long",
				sessionId: "session-2",
				maxTokens: 456,
			},
		).result();

		expect(result.content).toEqual([{ type: "thinking", thinking: "hidden", thinkingSignature: "reasoning" }]);
		expect(result.usage).toMatchObject({
			input: 1,
			output: 1,
			cacheRead: 1,
		});
		expect(mockState.lastClientOptions).toMatchObject({
			defaultHeaders: {
				session_id: "session-2",
				"x-client-request-id": "session-2",
				"x-session-affinity": "session-2",
			},
		});
		expect(mockState.lastParams).toMatchObject({
			max_tokens: 456,
			prompt_cache_retention: undefined,
			tool_stream: true,
			enable_thinking: false,
			tools: [
				{
					function: {
						name: "edit",
					},
				},
			],
		});
		expect(mockState.lastParams).not.toHaveProperty("stream_options");
		expect(mockState.lastParams).not.toHaveProperty("store");
		expect(mockState.lastParams).toMatchObject({
			tools: [
				{
					function: expect.not.objectContaining({
						strict: expect.anything(),
					}),
				},
			],
		});
	});

	it("maps provider-specific thinking and routing parameters", async () => {
		const cases = [
			{
				name: "qwen",
				model: completionsModel({ compat: { thinkingFormat: "qwen" } }),
				options: { apiKey: "test-key", reasoningEffort: "medium" } satisfies OpenAICompletionsOptions,
				expected: { enable_thinking: true },
			},
			{
				name: "qwen-chat-template",
				model: completionsModel({ compat: { thinkingFormat: "qwen-chat-template" } }),
				options: { apiKey: "test-key", reasoningEffort: "low" } satisfies OpenAICompletionsOptions,
				expected: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
			},
			{
				name: "deepseek",
				model: completionsModel({
					provider: "deepseek",
					baseUrl: "https://api.deepseek.com/v1",
					thinkingLevelMap: { high: "deep-high" },
				}),
				options: { apiKey: "test-key", reasoningEffort: "high" } satisfies OpenAICompletionsOptions,
				expected: { thinking: { type: "enabled" }, reasoning_effort: "deep-high" },
			},
			{
				name: "deepseek-disabled",
				model: completionsModel({
					provider: "deepseek",
					baseUrl: "https://api.deepseek.com/v1",
				}),
				options: { apiKey: "test-key" } satisfies OpenAICompletionsOptions,
				expected: { thinking: { type: "disabled" } },
			},
			{
				name: "openrouter-off",
				model: completionsModel({
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					thinkingLevelMap: { off: "none" },
					compat: { openRouterRouting: { order: ["OpenAI"] } },
				}),
				options: { apiKey: "test-key" } satisfies OpenAICompletionsOptions,
				expected: { reasoning: { effort: "none" }, provider: { order: ["OpenAI"] } },
			},
			{
				name: "openrouter-off-null",
				model: completionsModel({
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					thinkingLevelMap: { off: null },
				}),
				options: { apiKey: "test-key" } satisfies OpenAICompletionsOptions,
				expected: {},
			},
			{
				name: "openrouter-effort-default",
				model: completionsModel({
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
				}),
				options: { apiKey: "test-key", reasoningEffort: "medium" } satisfies OpenAICompletionsOptions,
				expected: { reasoning: { effort: "medium" } },
			},
			{
				name: "openrouter-effort",
				model: completionsModel({
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					thinkingLevelMap: { medium: "router-medium" },
				}),
				options: { apiKey: "test-key", reasoningEffort: "medium" } satisfies OpenAICompletionsOptions,
				expected: { reasoning: { effort: "router-medium" } },
			},
			{
				name: "together",
				model: completionsModel({
					provider: "together",
					baseUrl: "https://api.together.ai/v1",
					compat: { supportsReasoningEffort: true },
					thinkingLevelMap: { low: "together-low" },
				}),
				options: { apiKey: "test-key", reasoningEffort: "low" } satisfies OpenAICompletionsOptions,
				expected: { reasoning: { enabled: true }, reasoning_effort: "together-low" },
			},
			{
				name: "together-no-effort-support",
				model: completionsModel({
					provider: "together",
					baseUrl: "https://api.together.ai/v1",
					compat: { supportsReasoningEffort: false },
					thinkingLevelMap: { low: "together-low" },
				}),
				options: { apiKey: "test-key", reasoningEffort: "low" } satisfies OpenAICompletionsOptions,
				expected: { reasoning: { enabled: true } },
			},
			{
				name: "openai-effort-default",
				model: completionsModel(),
				options: { apiKey: "test-key", reasoningEffort: "medium" } satisfies OpenAICompletionsOptions,
				expected: { reasoning_effort: "medium" },
			},
			{
				name: "openai-off",
				model: completionsModel({ thinkingLevelMap: { off: "none" } }),
				options: { apiKey: "test-key" } satisfies OpenAICompletionsOptions,
				expected: { reasoning_effort: "none" },
			},
		];

		for (const testCase of cases) {
			mockState.chunks = terminalChunk();

			await streamOpenAICompletions(testCase.model, { messages: [] }, testCase.options).result();

			if (testCase.name === "openrouter-off-null") {
				expect(mockState.lastParams, testCase.name).not.toHaveProperty("reasoning");
			} else if (testCase.name === "together-no-effort-support") {
				expect(mockState.lastParams, testCase.name).toMatchObject(testCase.expected);
				expect(mockState.lastParams, testCase.name).not.toHaveProperty("reasoning_effort");
			} else {
				expect(mockState.lastParams, testCase.name).toMatchObject(testCase.expected);
			}
		}
	});

	it("maps provider finish reasons onto assistant stop reasons", async () => {
		const cases = [
			{ finishReason: "length", expected: { stopReason: "length" } },
			{ finishReason: null, expected: { stopReason: "stop" } },
			{ finishReason: "function_call", expected: { stopReason: "toolUse" } },
			{
				finishReason: "content_filter",
				expected: { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" },
			},
			{
				finishReason: "network_error",
				expected: { stopReason: "error", errorMessage: "Provider finish_reason: network_error" },
			},
			{
				finishReason: "made_up",
				expected: { stopReason: "error", errorMessage: "Provider finish_reason: made_up" },
			},
		];

		for (const testCase of cases) {
			mockState.chunks = terminalChunk(testCase.finishReason);

			await expect(
				streamOpenAICompletions(completionsModel(), { messages: [] }, { apiKey: "test-key" }).result(),
			).resolves.toMatchObject(testCase.expected);
		}
	});

	it("maps simple options and rejects missing API keys before streaming", async () => {
		expect(() =>
			streamSimpleOpenAICompletions(completionsModel({ provider: "unknown-provider" }), { messages: [] }),
		).toThrow("No API key for provider: unknown-provider");

		mockState.chunks = [
			{
				id: "chatcmpl_3",
				created: 1,
				model: "gpt-test",
				object: "chat.completion.chunk",
				choices: [{ index: 0, delta: { content: "simple" }, finish_reason: "stop" }],
			},
		];

		const simpleOptions: SimpleStreamOptions & Pick<OpenAICompletionsOptions, "toolChoice"> = {
			apiKey: "test-key",
			reasoning: "xhigh",
			maxTokens: 256,
			toolChoice: "none",
		};

		const result = await streamSimpleOpenAICompletions(completionsModel(), { messages: [] }, simpleOptions).result();

		expect(result.content).toEqual([{ type: "text", text: "simple" }]);
		expect(mockState.lastParams).toMatchObject({
			max_completion_tokens: 256,
			reasoning_effort: "high",
			tool_choice: "none",
		});

		mockState.chunks = terminalChunk();
		await streamSimpleOpenAICompletions(
			completionsModel({ thinkingLevelMap: { off: "none" } }),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();
		expect(mockState.lastParams).toMatchObject({ reasoning_effort: "none" });

		mockState.chunks = terminalChunk();
		await streamSimpleOpenAICompletions(
			completionsModel(),
			{ messages: [] },
			{ apiKey: "test-key", reasoning: "off" as SimpleStreamOptions["reasoning"] },
		).result();
		expect(mockState.lastParams).not.toHaveProperty("reasoning_effort");
	});

	it("returns provider failures and aborted requests through the stream protocol", async () => {
		const upstreamError = Object.assign(new Error("upstream failed"), {
			error: { metadata: { raw: "raw detail" } },
		});
		mockState.createError = upstreamError;
		const failed = await streamOpenAICompletions(
			completionsModel(),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toBe("upstream failed\nraw detail");

		mockState.createError = { code: "bad_request" };
		const objectFailure = await streamOpenAICompletions(
			completionsModel(),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();
		expect(objectFailure.stopReason).toBe("error");
		expect(objectFailure.errorMessage).toBe('{"code":"bad_request"}');

		mockState.createError = undefined;
		mockState.chunks = [
			{
				id: "chatcmpl_4",
				created: 1,
				model: "gpt-test",
				object: "chat.completion.chunk",
				choices: [{ index: 0, delta: { content: "nope" }, finish_reason: "stop" }],
			},
		];
		const controller = new AbortController();
		controller.abort();
		const aborted = await streamOpenAICompletions(
			completionsModel(),
			{ messages: [] },
			{
				apiKey: "test-key",
				signal: controller.signal,
			},
		).result();

		expect(aborted.stopReason).toBe("aborted");
		expect(aborted.errorMessage).toBe("Request was aborted");
		expect(aborted.content).toEqual([{ type: "text", text: "nope" }]);
	});

	it("normalizes empty usage chunks", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl_empty_usage",
				created: 1,
				model: "gpt-test",
				object: "chat.completion.chunk",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {},
			},
		];

		const result = await streamOpenAICompletions(
			completionsModel(),
			{ messages: [] },
			{ apiKey: "test-key" },
		).result();

		expect(result.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
	});
});
