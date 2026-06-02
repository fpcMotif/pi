import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
	streamSimpleOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import type { Context, Model, ProviderResponse } from "../src/types.js";

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function accountToken(accountId = "acc_edge"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `header.${payload}.signature`;
}

function model(overrides: Partial<Model<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
		...overrides,
	};
}

function context(): Context {
	return {
		systemPrompt: "Be exact.",
		messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
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

function sseResponse(text = "Hello", status = "completed"): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", delta: text, logprobs: [] },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status,
				service_tier: "flex",
				usage: {
					input_tokens: 8,
					output_tokens: 3,
					total_tokens: 11,
					input_tokens_details: { cached_tokens: 2 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		},
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function rawSseResponse(lines: string[]): Response {
	return new Response(`${lines.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function websocketTextEvents(text = "websocket ok"): Array<Record<string, unknown>> {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_ws",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_ws",
				status: "completed",
				usage: {
					input_tokens: 2,
					output_tokens: 1,
					total_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		},
	];
}

function encodeWebSocketData(text: string, index: number): unknown {
	if (index === 1) {
		return new TextEncoder().encode(text).buffer;
	}
	if (index === 2) {
		return new TextEncoder().encode(text);
	}
	if (index === 3) {
		const data = new TextEncoder().encode(text);
		return { arrayBuffer: async () => data.buffer };
	}
	return text;
}

describe("openai-codex provider edge behavior", () => {
	it("reports missing and malformed credentials through the stream protocol", async () => {
		delete process.env.OPENAI_CODEX_API_KEY;

		const missing = await streamOpenAICodexResponses(model(), { messages: [] }, { transport: "sse" }).result();
		expect(missing.stopReason).toBe("error");
		expect(missing.errorMessage).toBe("No API key for provider: openai-codex");

		expect(() => streamSimpleOpenAICodexResponses(model(), { messages: [] })).toThrow(
			"No API key for provider: openai-codex",
		);

		const malformed = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: "not-a-jwt", transport: "sse" },
		).result();
		expect(malformed.stopReason).toBe("error");
		expect(malformed.errorMessage).toBe("Failed to extract accountId from token");
	});

	it("lets hooks inspect/replace payloads and observes response metadata", async () => {
		const responses: ProviderResponse[] = [];
		let sentBody: Record<string, unknown> | undefined;
		let sentHeaders: Headers | undefined;

		global.fetch = vi.fn(async (_input: string | URL, init?: RequestInit): Promise<Response> => {
			sentHeaders = init?.headers instanceof Headers ? init.headers : undefined;
			sentBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return sseResponse("patched");
		}) as typeof fetch;

		const result = await streamOpenAICodexResponses(model({ headers: { "x-model": "base" } }), context(), {
			apiKey: accountToken("acc_hook"),
			transport: "sse",
			headers: { "x-user": "override" },
			sessionId: "session-hook",
			temperature: 0.25,
			serviceTier: "flex",
			textVerbosity: "medium",
			reasoningEffort: "none",
			reasoningSummary: "off",
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				model: "patched-model",
				metadata: { patched: true },
			}),
			onResponse: (response) => {
				responses.push(response);
			},
		}).result();

		expect(result.content).toEqual([{ type: "text", text: "patched", textSignature: '{"v":1,"id":"msg_1"}' }]);
		expect(result.usage).toMatchObject({ input: 6, output: 3, cacheRead: 2, totalTokens: 11 });
		expect(result.usage.cost.total).toBeCloseTo(6 * 0.000001 * 0.5 + 3 * 0.000002 * 0.5 + 2 * 0.00000025 * 0.5);
		expect(responses).toEqual([{ status: 200, headers: { "content-type": "text/event-stream" } }]);
		expect(sentHeaders?.get("Authorization")).toBe(`Bearer ${accountToken("acc_hook")}`);
		expect(sentHeaders?.get("chatgpt-account-id")).toBe("acc_hook");
		expect(sentHeaders?.get("x-model")).toBe("base");
		expect(sentHeaders?.get("x-user")).toBe("override");
		expect(sentHeaders?.get("session_id")).toBe("session-hook");
		expect(sentBody).toMatchObject({
			model: "patched-model",
			instructions: "Be exact.",
			prompt_cache_key: "session-hook",
			temperature: 0.25,
			service_tier: "flex",
			text: { verbosity: "medium" },
			metadata: { patched: true },
			tools: [{ type: "function", name: "echo", strict: null }],
			reasoning: { effort: "none", summary: "off" },
		});
	});

	it("returns friendly usage-limit errors after retry exhaustion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const fetchMock = vi.fn(
			async (): Promise<Response> =>
				Response.json(
					{
						error: {
							code: "usage_limit_reached",
							message: "daily limit reached",
							plan_type: "Plus",
							resets_at: 121,
						},
					},
					{ status: 429 },
				),
		);
		global.fetch = fetchMock as typeof fetch;

		const resultPromise = streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		await vi.advanceTimersByTimeAsync(7_000);
		const result = await resultPromise;

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("You have hit your ChatGPT usage limit (plus plan). Try again in ~2 min.");
	});

	it("formats usage-limit errors without reset timestamps", async () => {
		global.fetch = vi.fn(
			async (): Promise<Response> =>
				Response.json(
					{
						error: {
							code: "usage_not_included",
							plan_type: "Free",
						},
					},
					{ status: 403 },
				),
		) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("You have hit your ChatGPT usage limit (free plan).");
	});

	it("preserves plain-text Codex error responses", async () => {
		global.fetch = vi.fn(
			async (): Promise<Response> =>
				new Response("plain upstream failure", { status: 400, statusText: "Bad Request" }),
		) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("plain upstream failure");
	});

	it("retries transient server failures before consuming the successful SSE stream", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(new Response("temporarily overloaded", { status: 503, statusText: "Unavailable" }))
			.mockResolvedValueOnce(sseResponse("retry ok"));
		global.fetch = fetchMock as typeof fetch;

		const resultPromise = streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();

		await vi.advanceTimersByTimeAsync(1_000);
		const result = await resultPromise;

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "retry ok", textSignature: '{"v":1,"id":"msg_1"}' }]);
	});

	it("honors aborts while waiting for retry backoff", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const retryResponse = {
			ok: false,
			status: 503,
			statusText: "Unavailable",
			headers: new Headers(),
			text: async () => {
				setTimeout(() => controller.abort(), 0);
				return "temporarily overloaded";
			},
		} as Response;
		const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(retryResponse);
		global.fetch = fetchMock as typeof fetch;

		const resultPromise = streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse", signal: controller.signal },
		).result();
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("reports aborts raised after the SSE response is accepted", async () => {
		const controller = new AbortController();
		global.fetch = vi.fn(async (): Promise<Response> => sseResponse("accepted")) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{
				apiKey: accountToken(),
				transport: "sse",
				signal: controller.signal,
				onResponse: () => {
					controller.abort();
				},
			},
		).result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("reports Codex SSE error and protocol failures", async () => {
		global.fetch = vi.fn(
			async (): Promise<Response> =>
				rawSseResponse([`data: ${JSON.stringify({ type: "error", code: "bad_request", message: "bad input" })}`]),
		) as typeof fetch;

		const apiError = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		expect(apiError.stopReason).toBe("error");
		expect(apiError.errorMessage).toBe("Codex error: bad input");

		global.fetch = vi.fn(async (): Promise<Response> => rawSseResponse(["data: {not-json"])) as typeof fetch;

		const protocolError = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		expect(protocolError.stopReason).toBe("error");
		expect(protocolError.errorMessage).toContain("Invalid Codex SSE JSON:");
	});

	it("reports response failures and missing bodies from SSE transport", async () => {
		global.fetch = vi.fn(
			async (): Promise<Response> =>
				rawSseResponse([
					`data: ${JSON.stringify({
						type: "response.failed",
						response: { error: { code: "invalid_request", message: "nope" } },
					})}`,
				]),
		) as typeof fetch;

		const failed = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toBe("nope");

		global.fetch = vi.fn(async (): Promise<Response> => new Response(null, { status: 200 })) as typeof fetch;

		const noBody = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		expect(noBody.stopReason).toBe("error");
		expect(noBody.errorMessage).toBe("No response body");

		global.fetch = vi.fn(
			async (): Promise<Response> => rawSseResponse([`data: ${JSON.stringify({ type: "response.completed" })}`]),
		) as typeof fetch;

		const completedWithoutResponse = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		expect(completedWithoutResponse.stopReason).toBe("stop");

		global.fetch = vi.fn(
			async (): Promise<Response> =>
				rawSseResponse([`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_created" } })}`]),
		) as typeof fetch;

		const createdOnly = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		expect(createdOnly.responseId).toBe("resp_created");
	});

	it("uses text retry hints and honors aborts before issuing SSE requests", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(new Response("upstream connect refused", { status: 400, statusText: "Bad Request" }))
			.mockResolvedValueOnce(sseResponse("regex retry"));
		global.fetch = fetchMock as typeof fetch;

		const resultPromise = streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse" },
		).result();
		await vi.advanceTimersByTimeAsync(1_000);
		const result = await resultPromise;

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.content).toEqual([{ type: "text", text: "regex retry", textSignature: '{"v":1,"id":"msg_1"}' }]);

		const controller = new AbortController();
		controller.abort();
		fetchMock.mockClear();
		const aborted = await streamOpenAICodexResponses(
			model(),
			{ messages: [] },
			{ apiKey: accountToken(), transport: "sse", signal: controller.signal },
		).result();
		expect(aborted.stopReason).toBe("aborted");
		expect(aborted.errorMessage).toBe("Request was aborted");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses a timestamp request id fallback when crypto.randomUUID is unavailable", async () => {
		const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		global.fetch = vi.fn(async (): Promise<Response> => sseResponse("fallback request id")) as typeof fetch;
		Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });

		try {
			const result = await streamOpenAICodexResponses(
				model(),
				{ messages: [] },
				{ apiKey: accountToken(), transport: "sse" },
			).result();
			expect(result.content).toEqual([
				{ type: "text", text: "fallback request id", textSignature: '{"v":1,"id":"msg_1"}' },
			]);
		} finally {
			if (cryptoDescriptor) {
				Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
			}
		}
	});

	it("streams over a one-shot WebSocket without falling back to fetch", async () => {
		const sentBodies: unknown[] = [];
		let closeCount = 0;

		class MockWebSocket {
			readyState = 1;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBodies.push(JSON.parse(data));
				queueMicrotask(() => {
					websocketTextEvents().forEach((event, index) => {
						this.dispatch("message", { data: encodeWebSocketData(JSON.stringify(event), index) });
					});
				});
			}

			close(): void {
				this.readyState = 3;
				closeCount++;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async (): Promise<Response> => new Response("unexpected", { status: 500 })) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Use websocket", timestamp: 1 }] },
			{ apiKey: accountToken(), transport: "websocket" },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "websocket ok" }]);
		expect(sentBodies).toHaveLength(1);
		expect(closeCount).toBe(1);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("does not fall back to SSE after WebSocket streaming has started", async () => {
		class StartedThenFailedWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(): void {
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({
							type: "response.output_item.added",
							item: {
								type: "message",
								id: "msg_started",
								role: "assistant",
								status: "in_progress",
								content: [],
							},
						}),
					});
					this.dispatch("error", { message: "websocket broke after start" });
				});
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = StartedThenFailedWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async (): Promise<Response> => sseResponse("should not fallback")) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Start then fail", timestamp: 1 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-started-failure" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("websocket broke after start");
		expect(result.diagnostics?.[0]).toMatchObject({
			type: "provider_transport_failure",
			details: {
				eventsEmitted: true,
				phase: "after_message_stream_start",
			},
		});
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("reuses cached WebSocket sessions and sends only continuation deltas", async () => {
		const instances: CachedWebSocket[] = [];

		class CachedWebSocket {
			readyState = 1;
			readonly sentBodies: Array<Record<string, unknown>> = [];
			closeCount = 0;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				instances.push(this);
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				this.sentBodies.push(request);
				const responseId = `resp_cached_${instances.length}_${this.sentBodies.length}`;
				queueMicrotask(() => {
					for (const event of websocketTextEvents(`cached ${this.sentBodies.length}`)) {
						const next =
							event.type === "response.completed"
								? { ...event, response: { ...(event.response as Record<string, unknown>), id: responseId } }
								: event;
						this.dispatch("message", { data: JSON.stringify(next) });
					}
					this.dispatch("close", { code: 1000, wasClean: true });
				});
			}

			close(): void {
				this.closeCount++;
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = CachedWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async (): Promise<Response> => new Response("unexpected", { status: 500 })) as typeof fetch;

		const firstUser = { role: "user" as const, content: "First", timestamp: 1 };
		const first = await streamOpenAICodexResponses(
			model(),
			{ messages: [firstUser] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-cache" },
		).result();
		const second = await streamOpenAICodexResponses(
			model(),
			{ messages: [firstUser, first, { role: "user", content: "Second", timestamp: 2 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-cache" },
		).result();

		expect(first.content).toMatchObject([{ type: "text", text: "cached 1" }]);
		expect(second.content).toMatchObject([{ type: "text", text: "cached 2" }]);
		expect(instances).toHaveLength(1);
		expect(instances[0].sentBodies).toHaveLength(2);
		expect(instances[0].sentBodies[1]).toMatchObject({
			previous_response_id: "resp_cached_1_1",
		});
		expect(instances[0].sentBodies[1].input).toEqual([
			{ content: [{ text: "Second", type: "input_text" }], role: "user" },
		]);
		expect(getOpenAICodexWebSocketDebugStats("session-cache")).toMatchObject({
			requests: 2,
			connectionsCreated: 1,
			connectionsReused: 1,
			cachedContextRequests: 2,
			fullContextRequests: 1,
			deltaRequests: 1,
			lastPreviousResponseId: "resp_cached_1_1",
			lastDeltaInputItems: 1,
		});

		instances[0].readyState = 3;
		await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Third", timestamp: 3 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-cache" },
		).result();
		expect(instances).toHaveLength(2);

		closeOpenAICodexWebSocketSessions("session-cache");
		resetOpenAICodexWebSocketDebugStats("session-cache");
		expect(getOpenAICodexWebSocketDebugStats("session-cache")).toBeUndefined();
	});

	it("falls back to SSE when WebSocket construction fails before streaming starts", async () => {
		class ThrowingWebSocket {
			constructor() {
				throw new Error("constructor failed");
			}
		}
		globalThis.WebSocket = ThrowingWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async (): Promise<Response> => sseResponse("fallback ok")) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Fallback", timestamp: 1 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-fallback" },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "fallback ok", textSignature: '{"v":1,"id":"msg_1"}' }]);
		expect(result.diagnostics?.[0]).toMatchObject({
			type: "provider_transport_failure",
			error: { message: "constructor failed" },
		});
		expect(getOpenAICodexWebSocketDebugStats("session-fallback")).toMatchObject({
			websocketFailures: 1,
			sseFallbacks: 1,
			websocketFallbackActive: true,
		});

		const fallbackAgain = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Fallback again", timestamp: 2 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-fallback" },
		).result();

		expect(fallbackAgain.stopReason).toBe("stop");
		expect(getOpenAICodexWebSocketDebugStats("session-fallback")).toMatchObject({
			sseFallbacks: 2,
			websocketFallbackActive: true,
		});
	});

	it("falls back to SSE when WebSocket is unavailable or closes before opening", async () => {
		global.fetch = vi.fn(async (): Promise<Response> => sseResponse("no websocket fallback")) as typeof fetch;
		globalThis.WebSocket = undefined as unknown as typeof WebSocket;

		const unavailable = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Fallback", timestamp: 1 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-unavailable" },
		).result();

		expect(unavailable.content).toEqual([
			{ type: "text", text: "no websocket fallback", textSignature: '{"v":1,"id":"msg_1"}' },
		]);
		expect(getOpenAICodexWebSocketDebugStats("session-unavailable")?.lastWebSocketError).toBe(
			"WebSocket transport is not available in this runtime",
		);

		class ClosingWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("close", { code: 1009, wasClean: false }));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = ClosingWebSocket as unknown as typeof WebSocket;
		const closed = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Fallback", timestamp: 1 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-close" },
		).result();

		expect(closed.content).toEqual([
			{ type: "text", text: "no websocket fallback", textSignature: '{"v":1,"id":"msg_1"}' },
		]);
		expect(getOpenAICodexWebSocketDebugStats("session-close")?.lastWebSocketError).toBe(
			"WebSocket closed 1009 message too big",
		);
	});

	it("falls back to SSE with WebSocket error event details before streaming starts", async () => {
		class ErrorWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("error", { error: { message: "nested websocket failure" } }));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = ErrorWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async (): Promise<Response> => sseResponse("error fallback")) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Fallback", timestamp: 1 }] },
			{ apiKey: accountToken(), transport: "auto", sessionId: "session-error-event" },
		).result();

		expect(result.content).toEqual([{ type: "text", text: "error fallback", textSignature: '{"v":1,"id":"msg_1"}' }]);
		expect(getOpenAICodexWebSocketDebugStats("session-error-event")?.lastWebSocketError).toBe(
			"nested websocket failure",
		);
	});

	it("does not fall back when WebSocket payload parsing fails", async () => {
		class InvalidJsonWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(): void {
				queueMicrotask(() => this.dispatch("message", { data: "{not-json" }));
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}

		globalThis.WebSocket = InvalidJsonWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async (): Promise<Response> => sseResponse("should not fetch")) as typeof fetch;

		const result = await streamOpenAICodexResponses(
			model(),
			{ messages: [{ role: "user", content: "Bad websocket", timestamp: 1 }] },
			{ apiKey: accountToken(), transport: "auto" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid Codex WebSocket JSON:");
		expect(global.fetch).not.toHaveBeenCalled();
	});
});
