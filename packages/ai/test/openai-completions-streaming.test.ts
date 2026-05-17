import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.js";

// =============================================================================
// Test infrastructure: a configurable fake openai SDK module.
// =============================================================================

interface FakeOpenAIState {
	chunks: unknown[];
	lastParams?: unknown;
	lastRequestOptions?: unknown;
	clientCtorOpts?: { apiKey?: string; baseURL?: string; defaultHeaders?: Record<string, string> };
	throwOnCreate?: Error;
}

const fakeState = vi.hoisted(
	(): FakeOpenAIState => ({
		chunks: [],
	}),
);

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown, requestOptions?: unknown) => {
					fakeState.lastParams = params;
					fakeState.lastRequestOptions = requestOptions;
					const chunks = fakeState.chunks;
					const throwOnCreate = fakeState.throwOnCreate;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						if (throwOnCreate) {
							throw throwOnCreate;
						}
						return {
							data: stream,
							response: { status: 200, headers: new Headers({ "x-trace": "abc" }) },
						};
					};
					return promise;
				},
			},
		};
		constructor(opts: FakeOpenAIState["clientCtorOpts"]) {
			fakeState.clientCtorOpts = opts;
		}
	}
	return { default: FakeOpenAI };
});

beforeEach(() => {
	fakeState.chunks = [];
	fakeState.lastParams = undefined;
	fakeState.lastRequestOptions = undefined;
	fakeState.clientCtorOpts = undefined;
	fakeState.throwOnCreate = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// Helpers
// =============================================================================

function baseModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

async function drainToMessage(model: Model<"openai-completions">, context: Context, options?: any) {
	return streamOpenAICompletions(model, context, options).result();
}

// =============================================================================
// streamOpenAICompletions: tools, text, thinking, errors
// =============================================================================

describe("openai-completions streaming", () => {
	it("streams content, tool calls, and reasoning fields", async () => {
		fakeState.chunks = [
			{
				id: "cmpl-1",
				model: "gpt-4o-mini",
				choices: [
					{
						index: 0,
						delta: { content: "Hi", reasoning_content: "thoughts " },
					},
				],
			},
			{
				id: "cmpl-1",
				model: "gpt-4o-mini",
				choices: [
					{
						index: 0,
						delta: { content: "!", reasoning_content: "more" },
					},
				],
			},
			{
				id: "cmpl-1",
				model: "gpt-4o-mini",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "tc-1",
									function: { name: "say_hello", arguments: '{"name":' },
								},
							],
						},
					},
				],
			},
			{
				id: "cmpl-1",
				model: "gpt-4o-mini",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: '"world"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 7,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			},
		];

		const tool: Tool = {
			name: "say_hello",
			description: "Say hello",
			parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } as any,
		};

		const result = await drainToMessage(
			baseModel({ reasoning: true }),
			{
				systemPrompt: "be brief",
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "k" },
		);

		expect(result.stopReason).toBe("toolUse");
		expect(result.content.find((b) => b.type === "text")?.type).toBe("text");
		expect((result.content.find((b) => b.type === "text") as any).text).toBe("Hi!");
		expect((result.content.find((b) => b.type === "thinking") as any).thinking).toContain("thoughts");
		const tc = result.content.find((b) => b.type === "toolCall") as any;
		expect(tc.id).toBe("tc-1");
		expect(tc.name).toBe("say_hello");
		expect(tc.arguments).toEqual({ name: "world" });
	});

	it("maps stop reason 'length' from finish_reason 'length'", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: { content: "abc" }, finish_reason: "length" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.stopReason).toBe("length");
	});

	it("maps finish_reason 'content_filter' to error stopReason with errorMessage", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: { content: "no" }, finish_reason: "content_filter" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content_filter");
	});

	it("maps unknown finish_reason to error stopReason", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "weird_state" }],
				usage: { prompt_tokens: 1, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("weird_state");
	});

	it("treats finish_reason 'function_call' as toolUse", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "function_call" }],
				usage: { prompt_tokens: 1, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.stopReason).toBe("toolUse");
	});

	it("emits an error event when the SDK rejects with metadata.raw", async () => {
		fakeState.throwOnCreate = Object.assign(new Error("upstream failure"), {
			error: { metadata: { raw: "provider raw detail" } },
		});
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("upstream failure");
		expect(result.errorMessage).toContain("provider raw detail");
	});

	it("emits an error event when the SDK rejects with a non-Error value", async () => {
		fakeState.throwOnCreate = "string-error" as unknown as Error;
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("string-error");
	});

	it("emits aborted stopReason when signal.aborted is set after streaming", async () => {
		const controller = new AbortController();
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: { content: "abc" }, finish_reason: null }],
			},
		];
		// Pre-abort: the stream will iterate, then the final check throws.
		controller.abort();
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", signal: controller.signal },
		);
		expect(result.stopReason).toBe("aborted");
	});

	it("treats finish_reason 'network_error' as an error stop reason", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "network_error" }],
				usage: { prompt_tokens: 1, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("network_error");
	});

	it("falls back to choice.usage when chunk.usage is absent (Moonshot)", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [
					{
						index: 0,
						delta: { content: "z" },
						finish_reason: "stop",
						usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
					},
				],
			},
		];
		const result = await drainToMessage(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(result.usage.input).toBe(3);
		expect(result.usage.cacheRead).toBe(1);
		expect(result.usage.output).toBe(2);
	});

	it("supports reasoning_details with encrypted thoughtSignature attached to a tool call", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "tcZ",
									function: { name: "noop", arguments: "{}" },
								},
							],
							reasoning_details: [{ type: "reasoning.encrypted", id: "tcZ", data: "cipher" }],
						},
					},
				],
			},
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const result = await drainToMessage(
			baseModel({ reasoning: true }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		const tc = result.content.find((b) => b.type === "toolCall") as any;
		expect(tc).toBeDefined();
		expect(tc.thoughtSignature).toBeDefined();
		const decoded = JSON.parse(tc.thoughtSignature);
		expect(decoded).toMatchObject({ type: "reasoning.encrypted", id: "tcZ", data: "cipher" });
	});
});

// =============================================================================
// buildParams: providers, thinking formats, cache control, tool history
// =============================================================================

describe("openai-completions buildParams", () => {
	async function captureParams(model: Model<"openai-completions">, context: Context, options?: any) {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		await streamOpenAICompletions(model, context, options).result();
		return fakeState.lastParams as any;
	}

	it("adds the developer role for reasoning models that support it", async () => {
		const params = await captureParams(
			baseModel({ reasoning: true }),
			{
				systemPrompt: "you are helpful",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "k" },
		);
		expect(params.messages[0]).toMatchObject({ role: "developer", content: "you are helpful" });
	});

	it("falls back to system role for non-reasoning models or when developer is unsupported", async () => {
		// Cerebras compat: supportsDeveloperRole=false, supportsStore=false, etc.
		const params = await captureParams(
			baseModel({ provider: "cerebras", baseUrl: "https://api.cerebras.ai/v1", reasoning: true }),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "k" },
		);
		expect(params.messages[0]).toMatchObject({ role: "system", content: "sys" });
		// supportsStore=false → no params.store
		expect("store" in params).toBe(false);
	});

	it("sets max_tokens for Moonshot and max_completion_tokens for OpenAI", async () => {
		const moonshot = await captureParams(
			baseModel({ provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", maxTokens: 256 },
		);
		expect(moonshot.max_tokens).toBe(256);

		const openai = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", maxTokens: 512 },
		);
		expect(openai.max_completion_tokens).toBe(512);
	});

	it("passes through temperature and toolChoice", async () => {
		const params = await captureParams(
			baseModel(),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [
					{
						name: "ping",
						description: "ping",
						parameters: { type: "object", properties: {} } as any,
					},
				],
			},
			{ apiKey: "k", temperature: 0.3, toolChoice: "required" },
		);
		expect(params.temperature).toBe(0.3);
		expect(params.tool_choice).toBe("required");
	});

	it("emits empty tools array when conversation has tool history but caller passes no tools", async () => {
		const params = await captureParams(
			baseModel(),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "tc1", name: "doit", arguments: {} }],
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as AssistantMessage,
					{
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "doit",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "k" },
		);
		expect(params.tools).toEqual([]);
	});

	it("applies anthropic cache control on openrouter anthropic models", async () => {
		const params = await captureParams(
			baseModel({
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				id: "anthropic/claude-3-5-sonnet",
			}),
			{
				systemPrompt: "be helpful",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } as any }],
			},
			{ apiKey: "k" },
		);
		// system prompt got cache_control
		const systemMsg = params.messages[0];
		expect(systemMsg.content?.[0]?.cache_control).toMatchObject({ type: "ephemeral" });
		// last conversation message got cache_control
		const lastConv = params.messages[params.messages.length - 1];
		expect(lastConv.content?.[0]?.cache_control).toMatchObject({ type: "ephemeral" });
		// last tool got cache_control
		expect(params.tools?.[params.tools.length - 1].cache_control).toMatchObject({ type: "ephemeral" });
	});

	it("emits provider routing config for openrouter when supplied via model.compat", async () => {
		const params = await captureParams(
			baseModel({
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				compat: { openRouterRouting: { order: ["anthropic"] } } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect((params as any).provider).toEqual({ order: ["anthropic"] });
	});

	it("emits enable_thinking for zai when reasoning is enabled", async () => {
		const params = await captureParams(
			baseModel({
				provider: "zai",
				baseUrl: "https://api.z.ai/v1",
				reasoning: true,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoningEffort: "low" },
		);
		expect((params as any).enable_thinking).toBe(true);
	});

	it("emits chat_template_kwargs for qwen-chat-template thinking format", async () => {
		const params = await captureParams(
			baseModel({
				provider: "custom",
				baseUrl: "https://example.test/v1",
				reasoning: true,
				compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: false } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoningEffort: "low" },
		);
		expect((params as any).chat_template_kwargs).toEqual({
			enable_thinking: true,
			preserve_thinking: true,
		});
	});

	it("emits deepseek thinking object with reasoning_effort", async () => {
		const params = await captureParams(
			baseModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				reasoning: true,
				thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "high" } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoningEffort: "medium" },
		);
		expect((params as any).thinking).toEqual({ type: "enabled" });
		expect((params as any).reasoning_effort).toBe("medium");
	});

	it("emits openrouter reasoning effort", async () => {
		const params = await captureParams(
			baseModel({
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: true,
				thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "high" } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoningEffort: "high" },
		);
		expect((params as any).reasoning).toEqual({ effort: "high" });
	});

	it("emits openrouter reasoning effort 'off' when no reasoning level is set and off!=null", async () => {
		const params = await captureParams(
			baseModel({
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: true,
				thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "high" } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect((params as any).reasoning).toEqual({ effort: "none" });
	});

	it("emits together reasoning + reasoning_effort", async () => {
		const params = await captureParams(
			baseModel({
				provider: "together",
				baseUrl: "https://api.together.ai/v1",
				reasoning: true,
				compat: { supportsReasoningEffort: true } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoningEffort: "low" },
		);
		expect((params as any).reasoning).toEqual({ enabled: true });
		expect((params as any).reasoning_effort).toBe("low");
	});

	it("sets reasoning_effort to mapped off when reasoning model has no effort selected", async () => {
		const params = await captureParams(
			baseModel({
				reasoning: true,
				thinkingLevelMap: { off: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high" } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect((params as any).reasoning_effort).toBe("minimal");
	});
});

// =============================================================================
// convertMessages: images, thinking, foreign tool call ids, tool result name
// =============================================================================

describe("openai-completions convertMessages", () => {
	async function captureParams(model: Model<"openai-completions">, context: Context, options?: any) {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		await streamOpenAICompletions(model, context, options).result();
		return fakeState.lastParams as any;
	}

	it("converts a user image content to a data URL image_url", async () => {
		const params = await captureParams(
			baseModel({ input: ["text", "image"] }),
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "look at this" },
							{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "k" },
		);
		const userMsg = params.messages.find((m: any) => m.role === "user");
		const img = userMsg.content.find((c: any) => c.type === "image_url");
		expect(img.image_url.url).toBe("data:image/png;base64,ZmFrZQ==");
	});

	it("attaches tool-result images as a follow-up user message when model supports image input", async () => {
		const params = await captureParams(
			baseModel({ input: ["text", "image"] }),
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "tc1", name: "fetch", arguments: {} }],
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as AssistantMessage,
					{
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "fetch",
						content: [
							{ type: "text", text: "got it" },
							{ type: "image", mimeType: "image/png", data: "XX==" },
						],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "k" },
		);
		const toolMsg = params.messages.find((m: any) => m.role === "tool");
		expect(toolMsg.content).toBe("got it");
		const userImageMsg = params.messages.find(
			(m: any) =>
				m.role === "user" && Array.isArray(m.content) && m.content.some((c: any) => c.type === "image_url"),
		);
		expect(userImageMsg).toBeDefined();
	});

	it("normalizes pipe-separated tool call IDs for openai provider", async () => {
		const params = await captureParams(
			baseModel({ provider: "openai" }),
			{
				messages: [
					{
						role: "assistant",
						// Use a foreign assistant message (provider differs) so pipe id is normalized.
						content: [
							{
								type: "toolCall",
								id: "callXYZ|fooooo+/=verylong-call-id_with_chars",
								name: "doit",
								arguments: {},
							},
						],
						api: "openai-completions",
						provider: "openrouter",
						model: "anthropic/claude-3-5-sonnet",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as AssistantMessage,
					{
						role: "toolResult",
						toolCallId: "callXYZ|fooooo+/=verylong-call-id_with_chars",
						toolName: "doit",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "k" },
		);
		const assistantMsg = params.messages.find((m: any) => m.role === "assistant");
		// The tool_calls[0].id has the pipe-prefix sanitized; check it begins with the
		// callId portion and contains no special characters / no pipe.
		expect(assistantMsg.tool_calls[0].id).not.toContain("|");
		expect(assistantMsg.tool_calls[0].id).not.toContain("+");
		expect(assistantMsg.tool_calls[0].id).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(assistantMsg.tool_calls[0].id.length).toBeLessThanOrEqual(40);
	});

	it("truncates >40-char tool call ids for openai provider when no pipe is present", async () => {
		const longId = "x".repeat(80);
		const params = await captureParams(
			baseModel({ provider: "openai" }),
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: longId, name: "doit", arguments: {} }],
						api: "openai-completions",
						provider: "openrouter",
						model: "anthropic/claude-3-5-sonnet",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as AssistantMessage,
					{
						role: "toolResult",
						toolCallId: longId,
						toolName: "doit",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "k" },
		);
		const assistantMsg = params.messages.find((m: any) => m.role === "assistant");
		expect(assistantMsg.tool_calls[0].id.length).toBe(40);
	});

	it("renders thinking blocks as plain text when compat requires it", async () => {
		// Same model id so transformMessages keeps the thinking block intact.
		const params = await captureParams(
			baseModel({
				id: "matched-model",
				reasoning: true,
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				compat: { requiresThinkingAsText: true } as any,
			}),
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "I am thinking..." },
							{ type: "text", text: "answer" },
						],
						api: "openai-completions",
						provider: "openrouter",
						model: "matched-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					} as AssistantMessage,
					{ role: "user", content: "ok", timestamp: Date.now() },
				],
			},
			{ apiKey: "k" },
		);
		const assistantMsg = params.messages.find((m: any) => m.role === "assistant");
		expect(Array.isArray(assistantMsg.content)).toBe(true);
		expect(assistantMsg.content[0].text).toContain("I am thinking");
	});

	it("attaches reasoning_content to assistant messages for deepseek", async () => {
		const params = await captureParams(
			baseModel({
				provider: "deepseek",
				baseUrl: "https://api.deepseek.com/v1",
				reasoning: true,
				compat: { requiresReasoningContentOnAssistantMessages: true } as any,
			}),
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "answer" }],
						api: "openai-completions",
						provider: "deepseek",
						model: "deepseek-r1",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					} as AssistantMessage,
					{ role: "user", content: "ok", timestamp: Date.now() },
				],
			},
			{ apiKey: "k" },
		);
		const assistantMsg = params.messages.find((m: any) => m.role === "assistant");
		expect(assistantMsg.reasoning_content).toBe("");
	});

	it("includes the 'name' field in tool result messages when compat requires it", async () => {
		const params = await captureParams(
			baseModel({
				provider: "custom",
				baseUrl: "https://example.test/v1",
				compat: { requiresToolResultName: true } as any,
			}),
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "tc1", name: "ping", arguments: {} }],
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as AssistantMessage,
					{
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "ping",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "k" },
		);
		const toolMsg = params.messages.find((m: any) => m.role === "tool");
		expect(toolMsg.name).toBe("ping");
	});

	it("inserts a synthetic assistant message between toolResult and user when compat requires it", async () => {
		const params = await captureParams(
			baseModel({
				provider: "custom",
				baseUrl: "https://example.test/v1",
				compat: { requiresAssistantAfterToolResult: true } as any,
			}),
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "calling tool" },
							{ type: "toolCall", id: "tc1", name: "ping", arguments: {} },
						],
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as AssistantMessage,
					{
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "ping",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "what now?", timestamp: Date.now() },
				],
			},
			{ apiKey: "k" },
		);
		// Find tool message and the message right after it
		const toolIdx = params.messages.findIndex((m: any) => m.role === "tool");
		expect(params.messages[toolIdx + 1].role).toBe("assistant");
		expect(params.messages[toolIdx + 1].content).toContain("processed");
	});

	it("emits empty thinking signature key on assistant when signature is provided", async () => {
		// Same model so isSameModel=true → keep thinking with signature
		const params = await captureParams(
			baseModel({ reasoning: true }),
			{
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "x", thinkingSignature: "harmony" },
							{ type: "text", text: "answer" },
						],
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					} as AssistantMessage,
					{ role: "user", content: "ok", timestamp: Date.now() },
				],
			},
			{ apiKey: "k" },
		);
		const assistantMsg = params.messages.find((m: any) => m.role === "assistant");
		expect(assistantMsg.harmony).toBe("x");
	});
});

// =============================================================================
// streamSimpleOpenAICompletions
// =============================================================================

describe("streamSimpleOpenAICompletions", () => {
	it("throws when no API key is available", () => {
		expect(() =>
			streamSimpleOpenAICompletions(
				baseModel({ provider: "no-such-provider" }),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{},
			),
		).toThrow(/No API key for provider/);
	});

	it("delegates to streamOpenAICompletions with mapped reasoning effort", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const result = await streamSimpleOpenAICompletions(
			baseModel({ reasoning: true }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoning: "low" },
		).result();
		expect(result.stopReason).toBe("stop");
	});

	it("falls back to env OPENAI_API_KEY when apiKey is not provided directly", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const prev = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "env-key";
		try {
			const result = await streamSimpleOpenAICompletions(
				baseModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(fakeState.clientCtorOpts?.apiKey).toBe("env-key");
		} finally {
			if (prev === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prev;
		}
	});
});

// =============================================================================
// onPayload / onResponse hooks
// =============================================================================

describe("openai-completions hooks", () => {
	it("invokes onPayload with current params and uses the returned value", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const onPayload = vi.fn(async (params: any) => {
			return { ...params, custom_field: "yes" };
		});
		await streamOpenAICompletions(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", onPayload },
		).result();
		expect(onPayload).toHaveBeenCalled();
		expect((fakeState.lastParams as any).custom_field).toBe("yes");
	});

	it("invokes onResponse with the response status and headers", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		const onResponse = vi.fn();
		await streamOpenAICompletions(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", onResponse },
		).result();
		expect(onResponse).toHaveBeenCalledWith(
			expect.objectContaining({ status: 200, headers: expect.objectContaining({ "x-trace": "abc" }) }),
			expect.any(Object),
		);
	});

	it("passes timeout and maxRetries through to the SDK request options", async () => {
		fakeState.chunks = [
			{
				id: "x",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
			},
		];
		await streamOpenAICompletions(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", timeoutMs: 1234, maxRetries: 7 },
		).result();
		expect(fakeState.lastRequestOptions).toMatchObject({ timeout: 1234, maxRetries: 7 });
	});
});
