import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model, Tool } from "../src/types.js";

interface FakeOpenAIState {
	events: unknown[];
	lastParams?: any;
	lastRequestOptions?: unknown;
	clientCtorOpts?: { apiKey?: string; baseURL?: string; defaultHeaders?: Record<string, string> };
	createThrows?: Error;
	withResponseThrows?: Error;
}

const fakeState = vi.hoisted(
	(): FakeOpenAIState => ({
		events: [],
	}),
);

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: any, requestOptions?: unknown) => {
				fakeState.lastParams = params;
				fakeState.lastRequestOptions = requestOptions;
				if (fakeState.createThrows) {
					throw fakeState.createThrows;
				}
				const events = fakeState.events;
				const stream = {
					async *[Symbol.asyncIterator]() {
						for (const event of events) yield event;
					},
				};
				const promise = Promise.resolve(stream) as Promise<typeof stream> & {
					withResponse: () => Promise<{
						data: typeof stream;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => {
					if (fakeState.withResponseThrows) {
						throw fakeState.withResponseThrows;
					}
					return {
						data: stream,
						response: { status: 200, headers: new Headers({ "x-trace": "abc" }) },
					};
				};
				return promise;
			},
		};
		constructor(opts: FakeOpenAIState["clientCtorOpts"]) {
			fakeState.clientCtorOpts = opts;
		}
	}
	return { default: FakeOpenAI };
});

beforeEach(() => {
	fakeState.events = [];
	fakeState.lastParams = undefined;
	fakeState.lastRequestOptions = undefined;
	fakeState.clientCtorOpts = undefined;
	fakeState.createThrows = undefined;
	fakeState.withResponseThrows = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
});

function baseModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 16384,
		thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high", xhigh: "high" } as any,
		...overrides,
	};
}

function streamResult(events: unknown[]) {
	fakeState.events = events;
	return streamOpenAIResponses(
		baseModel(),
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "k" },
	).result();
}

// =============================================================================
// streamOpenAIResponses: full event stream
// =============================================================================

describe("streamOpenAIResponses", () => {
	it("streams reasoning, text, and tool call events to a complete message", async () => {
		const result = await streamResult([
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_1", content: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				part: { type: "summary_text", text: "" },
			},
			{ type: "response.reasoning_summary_text.delta", delta: "thinking..." },
			{ type: "response.reasoning_summary_part.done" },
			{
				type: "response.output_item.done",
				item: {
					type: "reasoning",
					id: "rs_1",
					summary: [{ type: "summary_text", text: "thinking..." }],
					content: [],
				},
			},
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", content: [] },
			},
			{
				type: "response.content_part.added",
				part: { type: "output_text", text: "" },
			},
			{ type: "response.output_text.delta", delta: "Hello" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "do", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				delta: '{"x":',
			},
			{
				type: "response.function_call_arguments.done",
				arguments: '{"x":1}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "do",
					arguments: '{"x":1}',
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
						input_tokens_details: { cached_tokens: 2 },
					},
				},
			},
		]);

		expect(result.responseId).toBe("resp_1");
		expect(result.stopReason).toBe("toolUse"); // tool call present overrides "stop"
		expect(result.content).toHaveLength(3);
		expect(result.content[0]).toMatchObject({ type: "thinking" });
		expect(result.content[1]).toMatchObject({ type: "text", text: "Hello" });
		expect(result.content[2]).toMatchObject({ type: "toolCall", name: "do", arguments: { x: 1 } });
		expect(result.usage.input).toBe(8);
		expect(result.usage.cacheRead).toBe(2);
	});

	it("maps response status 'incomplete' to stopReason 'length'", async () => {
		const result = await streamResult([
			{
				type: "response.completed",
				response: { status: "incomplete" },
			},
		]);
		expect(result.stopReason).toBe("length");
	});

	it("maps cancelled status to error stopReason", async () => {
		const result = await streamResult([
			{
				type: "response.completed",
				response: { status: "cancelled" },
			},
		]);
		expect(result.stopReason).toBe("error");
	});

	it("handles refusal deltas as text", async () => {
		const result = await streamResult([
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_2", role: "assistant", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "refusal", refusal: "" } },
			{ type: "response.refusal.delta", delta: "I cannot do that" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_2",
					role: "assistant",
					content: [{ type: "refusal", refusal: "I cannot do that" }],
				},
			},
			{ type: "response.completed", response: { status: "completed" } },
		]);
		// item.content has refusal, mapStopReason "completed" -> "stop"
		expect(result.stopReason).toBe("stop");
		expect((result.content[0] as any).text).toBe("I cannot do that");
	});

	it("throws via stream on 'error' events", async () => {
		const result = await streamResult([{ type: "error", code: "rate_limit", message: "too many" }]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("rate_limit");
		expect(result.errorMessage).toContain("too many");
	});

	it("throws via stream on 'response.failed' events with error info", async () => {
		const result = await streamResult([
			{
				type: "response.failed",
				response: {
					error: { code: "filter", message: "content filtered" },
				},
			},
		]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("filter");
		expect(result.errorMessage).toContain("content filtered");
	});

	it("throws via stream on 'response.failed' events with only incomplete_details", async () => {
		const result = await streamResult([
			{
				type: "response.failed",
				response: { incomplete_details: { reason: "filtered" } },
			},
		]);
		expect(result.errorMessage).toContain("incomplete: filtered");
	});

	it("throws via stream on 'response.failed' events with neither error nor incomplete_details", async () => {
		const result = await streamResult([{ type: "response.failed", response: {} }]);
		expect(result.errorMessage).toContain("Unknown error");
	});

	it("delta events without a current item are ignored cleanly", async () => {
		const result = await streamResult([
			{ type: "response.output_text.delta", delta: "orphan" },
			{ type: "response.refusal.delta", delta: "orphan" },
			{ type: "response.reasoning_text.delta", delta: "orphan" },
			{ type: "response.reasoning_summary_text.delta", delta: "orphan" },
			{ type: "response.function_call_arguments.delta", delta: "orphan" },
			{ type: "response.completed", response: { status: "completed" } },
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.length).toBe(0);
	});

	it("response.completed maps unhandled statuses through default branches", async () => {
		const result = await streamResult([{ type: "response.completed", response: { status: "queued" } }]);
		expect(result.stopReason).toBe("stop");
	});

	it("forwards in_progress status as stop", async () => {
		const result = await streamResult([{ type: "response.completed", response: { status: "in_progress" } }]);
		expect(result.stopReason).toBe("stop");
	});

	it("invokes onResponse with status and headers", async () => {
		fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
		const onResponse = vi.fn();
		await streamOpenAIResponses(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", onResponse },
		).result();
		expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }), expect.any(Object));
	});

	it("calls onPayload and uses the returned value", async () => {
		fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
		const onPayload = vi.fn(async (params: any) => ({ ...params, mutated: true }));
		await streamOpenAIResponses(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", onPayload },
		).result();
		expect((fakeState.lastParams as any).mutated).toBe(true);
	});

	it("aborts when signal.aborted is set after streaming", async () => {
		const controller = new AbortController();
		fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
		controller.abort();
		const result = await streamOpenAIResponses(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", signal: controller.signal },
		).result();
		expect(result.stopReason).toBe("aborted");
	});

	it("emits error stop reason when the stream returns error stop reason mid-stream", async () => {
		const result = await streamResult([{ type: "response.completed", response: { status: "failed" } }]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unknown error");
	});

	it("clears index/partialJson scratch fields on error", async () => {
		const result = await streamResult([
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc1", call_id: "call_x", name: "n", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", delta: '{"a' },
			{ type: "error", code: "boom", message: "boom!" },
		]);
		expect(result.stopReason).toBe("error");
		// content may still contain partial blocks; ensure partialJson is removed
		for (const block of result.content) {
			expect((block as any).partialJson).toBeUndefined();
		}
	});
});

// =============================================================================
// buildParams: tools, cache retention, reasoning effort, service tier
// =============================================================================

describe("openai-responses buildParams", () => {
	async function captureParams(model: Model<"openai-responses">, context: Context, options?: any) {
		fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
		await streamOpenAIResponses(model, context, options).result();
		return fakeState.lastParams as any;
	}

	it("sets max_output_tokens and temperature", async () => {
		const params = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", maxTokens: 1000, temperature: 0.5 },
		);
		expect(params.max_output_tokens).toBe(1000);
		expect(params.temperature).toBe(0.5);
	});

	it("converts tools into Responses-API format", async () => {
		const tool: Tool = {
			name: "ping",
			description: "ping a server",
			parameters: { type: "object", properties: { url: { type: "string" } } } as any,
		};
		const params = await captureParams(
			baseModel(),
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "k" },
		);
		expect(params.tools).toHaveLength(1);
		expect(params.tools[0]).toMatchObject({
			type: "function",
			name: "ping",
			description: "ping a server",
		});
	});

	it("sets reasoning when reasoningEffort is provided", async () => {
		const params = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoningEffort: "high" },
		);
		expect(params.reasoning).toMatchObject({ effort: "high", summary: "auto" });
		expect(params.include).toContain("reasoning.encrypted_content");
	});

	it("uses 'medium' default effort when only reasoningSummary is set", async () => {
		const params = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoningSummary: "detailed" },
		);
		expect(params.reasoning?.effort).toBe("medium");
		expect(params.reasoning?.summary).toBe("detailed");
	});

	it("sets a default reasoning 'off' effort for reasoning models when no effort is requested", async () => {
		const params = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(params.reasoning?.effort).toBe("none");
	});

	it("skips off-reasoning when thinkingLevelMap.off is null", async () => {
		const params = await captureParams(
			baseModel({
				thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "high" } as any,
			}),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(params.reasoning).toBeUndefined();
	});

	it("skips reasoning param for github-copilot", async () => {
		const params = await captureParams(
			baseModel({ provider: "github-copilot" }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k" },
		);
		expect(params.reasoning).toBeUndefined();
	});

	it("includes service_tier when supplied", async () => {
		const params = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", serviceTier: "flex" },
		);
		expect(params.service_tier).toBe("flex");
	});

	it("emits prompt_cache_retention=24h for long retention", async () => {
		const params = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", cacheRetention: "long", sessionId: "sess-1" },
		);
		expect(params.prompt_cache_key).toBe("sess-1");
		expect(params.prompt_cache_retention).toBe("24h");
	});

	it("omits prompt cache fields when cacheRetention is 'none'", async () => {
		const params = await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", cacheRetention: "none", sessionId: "sess-1" },
		);
		expect(params.prompt_cache_key).toBeUndefined();
		expect(params.prompt_cache_retention).toBeUndefined();
	});

	it("uses PI_CACHE_RETENTION=long when no explicit cacheRetention is set", async () => {
		const prev = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "long";
		try {
			const params = await captureParams(
				baseModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: "k", sessionId: "x" },
			);
			expect(params.prompt_cache_retention).toBe("24h");
		} finally {
			if (prev === undefined) delete process.env.PI_CACHE_RETENTION;
			else process.env.PI_CACHE_RETENTION = prev;
		}
	});

	it("omits 24h retention when compat.supportsLongCacheRetention=false", async () => {
		const params = await captureParams(
			baseModel({ compat: { supportsLongCacheRetention: false } as any }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", cacheRetention: "long", sessionId: "x" },
		);
		expect(params.prompt_cache_retention).toBeUndefined();
	});

	it("sets session_id and x-client-request-id headers when sessionId is provided", async () => {
		await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", sessionId: "session-abc" },
		);
		expect(fakeState.clientCtorOpts?.defaultHeaders?.session_id).toBe("session-abc");
		expect(fakeState.clientCtorOpts?.defaultHeaders?.["x-client-request-id"]).toBe("session-abc");
	});

	it("omits session_id header when compat.sendSessionIdHeader=false", async () => {
		await captureParams(
			baseModel({ compat: { sendSessionIdHeader: false } as any }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", sessionId: "session-abc" },
		);
		expect(fakeState.clientCtorOpts?.defaultHeaders?.session_id).toBeUndefined();
		// x-client-request-id still set
		expect(fakeState.clientCtorOpts?.defaultHeaders?.["x-client-request-id"]).toBe("session-abc");
	});

	it("omits session_id header entirely when cacheRetention is none", async () => {
		await captureParams(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", cacheRetention: "none", sessionId: "session-abc" },
		);
		expect(fakeState.clientCtorOpts?.defaultHeaders?.session_id).toBeUndefined();
	});

	it("merges in user-supplied default headers", async () => {
		await captureParams(
			baseModel({ headers: { "X-Model-Header": "yes" } }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", headers: { "X-Override": "ok" } },
		);
		expect(fakeState.clientCtorOpts?.defaultHeaders?.["X-Model-Header"]).toBe("yes");
		expect(fakeState.clientCtorOpts?.defaultHeaders?.["X-Override"]).toBe("ok");
	});

	it("throws when no API key is available", async () => {
		const prev = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const result = await streamOpenAIResponses(
				baseModel({ provider: "no-such-provider" }),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{},
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("API key is required");
		} finally {
			if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
		}
	});

	it("uses OPENAI_API_KEY env when no apiKey option is given", async () => {
		const prev = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "env-key";
		try {
			fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
			await streamOpenAIResponses(
				baseModel({ provider: "no-such-provider" }),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{},
			).result();
			expect(fakeState.clientCtorOpts?.apiKey).toBe("env-key");
		} finally {
			if (prev === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prev;
		}
	});

	it("forwards timeoutMs and maxRetries to request options", async () => {
		fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
		await streamOpenAIResponses(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", timeoutMs: 333, maxRetries: 9 },
		).result();
		expect(fakeState.lastRequestOptions).toMatchObject({ timeout: 333, maxRetries: 9 });
	});

	it("applies service tier pricing multiplier on usage", async () => {
		fakeState.events = [
			{
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: "priority",
					usage: {
						input_tokens: 100,
						output_tokens: 100,
						total_tokens: 200,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const result = await streamOpenAIResponses(
			baseModel({ id: "gpt-5.5", reasoning: false }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", serviceTier: "priority" },
		).result();
		// gpt-5.5 priority multiplier is 2.5
		expect(result.usage.cost.input).toBe((1 * 100 * 2.5) / 1e6);
		expect(result.usage.cost.output).toBe((2 * 100 * 2.5) / 1e6);
	});

	it("applies flex tier 0.5x discount", async () => {
		fakeState.events = [
			{
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: "flex",
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						total_tokens: 100,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const result = await streamOpenAIResponses(
			baseModel({ reasoning: false }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", serviceTier: "flex" },
		).result();
		expect(result.usage.cost.input).toBeCloseTo((1 * 100 * 0.5) / 1e6, 10);
	});

	it("non-gpt-5.5 priority tier uses 2x multiplier", async () => {
		fakeState.events = [
			{
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: "priority",
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						total_tokens: 100,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const result = await streamOpenAIResponses(
			baseModel({ id: "gpt-5.4", reasoning: false }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", serviceTier: "priority" },
		).result();
		expect(result.usage.cost.input).toBeCloseTo((1 * 100 * 2) / 1e6, 10);
	});
});

// =============================================================================
// streamSimpleOpenAIResponses
// =============================================================================

describe("streamSimpleOpenAIResponses", () => {
	it("throws when no API key is available", () => {
		const prev = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			expect(() =>
				streamSimpleOpenAIResponses(
					baseModel({ provider: "no-such-provider" }),
					{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
					{},
				),
			).toThrow(/No API key/);
		} finally {
			if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
		}
	});

	it("delegates to streamOpenAIResponses with mapped reasoning effort", async () => {
		fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
		const result = await streamSimpleOpenAIResponses(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoning: "low" },
		).result();
		expect(result.stopReason).toBe("stop");
	});

	it("treats reasoning='off' as no effort", async () => {
		fakeState.events = [{ type: "response.completed", response: { status: "completed" } }];
		const result = await streamSimpleOpenAIResponses(
			baseModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", reasoning: "off" },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(fakeState.lastParams?.reasoning?.effort).toBe("none");
	});
});
