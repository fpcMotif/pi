import type { ProxyAssistantMessageEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.js";

const usage: AssistantMessage["usage"] = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
};

const model: Model<string> = {
	id: "proxy-model",
	name: "Proxy Model",
	api: "proxy-api",
	provider: "proxy-provider",
	baseUrl: "https://llm.example",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const context: Context = {
	systemPrompt: "system",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function createSseResponse(events: ProxyAssistantMessageEvent[]): Response {
	const encoder = new TextEncoder();
	const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(payload));
				controller.close();
			},
		}),
		{ status: 200 },
	);
}

function throwNonError(value: unknown): never {
	throw value;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it("serializes proxy requests and reconstructs streamed assistant content", async () => {
		let requestInit: RequestInit | undefined;
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hello" },
			{ type: "text_end", contentIndex: 0, contentSignature: "text-sig" },
			{ type: "thinking_start", contentIndex: 1 },
			{ type: "thinking_delta", contentIndex: 1, delta: "Thought" },
			{ type: "thinking_end", contentIndex: 1, contentSignature: "thinking-sig" },
			{ type: "toolcall_start", contentIndex: 2, id: "tool-1", toolName: "read" },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"path":"a.txt"' },
			{ type: "toolcall_delta", contentIndex: 2, delta: ',"ok":true}' },
			{ type: "toolcall_end", contentIndex: 2 },
			{ type: "done", reason: "toolUse", usage },
		];
		const fetchStub = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
			requestInit = args[1];
			return createSseResponse(events);
		}) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, {
			authToken: "token",
			proxyUrl: "https://proxy.example",
			temperature: 0.2,
			maxTokens: 100,
			reasoning: "medium",
			cacheRetention: "long",
			sessionId: "session-1",
			headers: { "x-provider": "value" },
			metadata: { user_id: "user-1" },
			transport: "sse",
			thinkingBudgets: { medium: 1024 },
			maxRetryDelayMs: 5000,
		});

		const streamedEvents = await collectEvents(stream);
		const result = await stream.result();

		expect(streamedEvents.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.usage).toEqual(usage);
		expect(result.content).toEqual([
			{ type: "text", text: "Hello", textSignature: "text-sig" },
			{ type: "thinking", thinking: "Thought", thinkingSignature: "thinking-sig" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.txt", ok: true } },
		]);

		expect(requestInit).toMatchObject({
			method: "POST",
			headers: {
				Authorization: "Bearer token",
				"Content-Type": "application/json",
			},
		});
		const requestBody = JSON.parse(String(requestInit?.body)) as {
			model: Model<string>;
			context: Context;
			options: Record<string, unknown>;
		};
		expect(requestBody.model).toEqual(model);
		expect(requestBody.context).toEqual(context);
		expect(requestBody.options).toEqual({
			temperature: 0.2,
			maxTokens: 100,
			reasoning: "medium",
			cacheRetention: "long",
			sessionId: "session-1",
			headers: { "x-provider": "value" },
			metadata: { user_id: "user-1" },
			transport: "sse",
			thinkingBudgets: { medium: 1024 },
			maxRetryDelayMs: 5000,
		});
	});

	it("keeps empty tool arguments while streaming incomplete tool JSON", async () => {
		const fetchStub = (async (): Promise<Response> =>
			createSseResponse([
				{ type: "start" },
				{ type: "toolcall_start", contentIndex: 0, id: "tool-1", toolName: "read" },
				{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":' },
				{ type: "toolcall_end", contentIndex: 0 },
				{ type: "done", reason: "toolUse", usage },
			])) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(result.content).toEqual([{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]);
	});

	it("emits proxy error responses as stream errors", async () => {
		const fetchStub = (async (): Promise<Response> =>
			new Response(JSON.stringify({ error: "denied" }), {
				status: 403,
				statusText: "Forbidden",
			})) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Proxy error: denied");
	});

	it("falls back to HTTP status when proxy error JSON cannot be parsed", async () => {
		const fetchStub = (async (): Promise<Response> =>
			new Response("not json", {
				status: 502,
				statusText: "Bad Gateway",
			})) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(result.errorMessage).toBe("Proxy error: 502 Bad Gateway");
	});

	it("stringifies non-error fetch failures", async () => {
		const fetchStub = (async (): Promise<Response> => {
			throwNonError("network string");
		}) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("network string");
	});

	it("emits protocol errors when deltas arrive for the wrong content type", async () => {
		const fetchStub = (async (): Promise<Response> =>
			createSseResponse([
				{ type: "start" },
				{ type: "text_delta", contentIndex: 0, delta: "orphan" },
			])) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Received text_delta for non-text content");
	});

	it("emits protocol errors for mismatched end and tool events", async () => {
		const cases: Array<{ event: ProxyAssistantMessageEvent; message: string }> = [
			{ event: { type: "text_end", contentIndex: 0, contentSignature: "sig" }, message: "Received text_end" },
			{ event: { type: "thinking_delta", contentIndex: 0, delta: "x" }, message: "Received thinking_delta" },
			{
				event: { type: "thinking_end", contentIndex: 0, contentSignature: "sig" },
				message: "Received thinking_end",
			},
			{ event: { type: "toolcall_delta", contentIndex: 0, delta: "{}" }, message: "Received toolcall_delta" },
		];

		for (const testCase of cases) {
			const fetchStub = (async (): Promise<Response> =>
				createSseResponse([{ type: "start" }, testCase.event])) satisfies typeof fetch;
			vi.stubGlobal("fetch", fetchStub);

			const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
			const events = await collectEvents(stream);
			const result = await stream.result();

			expect(events.map((event) => event.type)).toEqual(["start", "error"]);
			expect(result.errorMessage).toContain(testCase.message);
		}
	});

	it("ignores orphan toolcall_end events and handles server error events", async () => {
		const fetchStub = (async (): Promise<Response> =>
			createSseResponse([
				{ type: "start" },
				{ type: "toolcall_end", contentIndex: 0 },
				{ type: "error", reason: "error", errorMessage: "server failed", usage },
			])) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("server failed");
		expect(result.usage).toEqual(usage);
	});

	it("ignores unknown proxy events", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchStub = (async (): Promise<Response> =>
			createSseResponse([
				{ type: "start" },
				{ type: "unknown" } as unknown as ProxyAssistantMessageEvent,
				{ type: "done", reason: "stop", usage },
			])) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, { authToken: "token", proxyUrl: "https://proxy.example" });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(warn).toHaveBeenCalledWith("Unhandled proxy event type: unknown");
	});

	it("marks stream errors as aborted when the request signal aborts", async () => {
		const encoder = new TextEncoder();
		const controller = new AbortController();
		const fetchStub = (async (): Promise<Response> =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(streamController) {
						streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
						controller.abort();
						streamController.close();
					},
				}),
				{ status: 200 },
			)) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, {
			authToken: "token",
			proxyUrl: "https://proxy.example",
			signal: controller.signal,
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request aborted by user");
	});

	it("cancels the active response reader when aborted after fetch resolves", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const fetchStub = (async (): Promise<Response> => {
			setTimeout(() => controller.abort(), 0);
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 200 },
			);
		}) satisfies typeof fetch;
		vi.stubGlobal("fetch", fetchStub);

		const stream = streamProxy(model, context, {
			authToken: "token",
			proxyUrl: "https://proxy.example",
			signal: controller.signal,
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(cancelled).toBe(true);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(result.stopReason).toBe("aborted");
	});
});
