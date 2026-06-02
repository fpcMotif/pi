import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 20, cacheRead: 2, cacheWrite: 4 },
		contextWindow: 400_000,
		maxTokens: 128_000,
		...overrides,
	};
}

function output(target: Model<"openai-responses"> = model()): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: target.api,
		provider: target.provider,
		model: target.id,
		usage: { ...usage, cost: { ...usage.cost } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function response(overrides: Partial<Response> = {}): Response {
	return {
		id: "resp_1",
		created_at: 1,
		output_text: "",
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		model: "gpt-test",
		object: "response",
		output: [],
		parallel_tool_calls: false,
		temperature: null,
		tool_choice: "auto",
		tools: [],
		top_p: null,
		...overrides,
	};
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

async function* responseEvents(...events: ResponseStreamEvent[]): AsyncIterable<ResponseStreamEvent> {
	yield* events;
}

function providerWireEvent(event: unknown): ResponseStreamEvent {
	return event as ResponseStreamEvent;
}

describe("openai responses message conversion", () => {
	it("preserves signed text phases, hashed long IDs, reasoning signatures, and image tool results", () => {
		const longId = `msg_${"x".repeat(80)}`;
		const reasoning = {
			type: "reasoning",
			id: "rs_1",
			summary: [{ type: "summary_text", text: "prior reasoning" }],
		};
		const context: Context = {
			systemPrompt: "system",
			messages: [
				assistant([
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
					{
						type: "text",
						text: "final",
						textSignature: JSON.stringify({ v: 1, id: longId, phase: "final_answer" }),
					},
					{
						type: "text",
						text: "commentary",
						textSignature: JSON.stringify({ v: 1, id: "msg_2", phase: "commentary" }),
					},
					{ type: "text", text: "legacy", textSignature: "legacy-id" },
				]),
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "screenshot",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", mimeType: "image/png", data: "abcd" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const converted = convertResponsesMessages(model(), context, new Set(["openai"]));

		expect(converted[0]).toMatchObject({ role: "developer", content: "system" });
		expect(converted[1]).toMatchObject(reasoning);
		expect(converted[2]).toMatchObject({
			type: "message",
			role: "assistant",
			id: expect.stringMatching(/^msg_[A-Za-z0-9]+$/),
			phase: "final_answer",
		});
		expect(converted[3]).toMatchObject({ type: "message", id: "msg_2", phase: "commentary" });
		expect(converted[4]).toMatchObject({ type: "message", id: "legacy-id" });
		expect(converted[5]).toMatchObject({
			type: "function_call_output",
			call_id: "call_1",
			output: [
				{ type: "input_text", text: "look" },
				{ type: "input_image", image_url: "data:image/png;base64,abcd" },
			],
		});
	});

	it("can omit system prompts and uses text placeholders for tool images on non-vision models", () => {
		const converted = convertResponsesMessages(
			model({ input: ["text"], reasoning: false }),
			{
				systemPrompt: "hidden",
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "screenshot",
						content: [{ type: "image", mimeType: "image/png", data: "abcd" }],
						isError: false,
						timestamp: 1,
					},
				],
			},
			new Set(["openai"]),
			{ includeSystemPrompt: false },
		);

		expect(converted).toEqual([
			{
				type: "function_call_output",
				call_id: "call_1",
				output: "(tool image omitted: model does not support images)",
			},
		]);
	});

	it("uses system role for non-reasoning models and skips empty user content arrays", () => {
		const converted = convertResponsesMessages(
			model({ reasoning: false }),
			{
				systemPrompt: "system",
				messages: [
					{ role: "user", content: [], timestamp: 1 },
					assistant([{ type: "toolCall", id: "call_without_separator", name: "no-pipe", arguments: {} }]),
				],
			},
			new Set<string>(),
		);

		expect(converted).toEqual([
			{ role: "system", content: "system" },
			{
				type: "function_call",
				id: undefined,
				call_id: "call_without_separator",
				name: "no-pipe",
				arguments: "{}",
			},
			{
				type: "function_call_output",
				call_id: "call_without_separator",
				output: "No result provided",
			},
		]);
	});

	it("normalizes user input, signatures, and cross-model tool calls", () => {
		const longToolId = `${"bad!".repeat(20)}|item_without_prefix`;
		const converted = convertResponsesMessages(
			model(),
			{
				systemPrompt: "system",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "hello" },
							{ type: "image", mimeType: "image/png", data: "abcd" },
						],
						timestamp: 1,
					},
					assistant([
						{ type: "text", text: "auto id" },
						{ type: "text", text: "invalid signature", textSignature: "{not-json" },
						{ type: "toolCall", id: "call_1|fc_existing", name: "same-provider", arguments: { ok: true } },
						{ type: "toolCall", id: "call_prefix|item_without_prefix", name: "needs-prefix", arguments: {} },
					]),
					assistant(
						[{ type: "toolCall", id: "call_2|fc_pair", name: "different-model", arguments: { ok: true } }],
						{ model: "older-gpt-test" },
					),
					assistant([{ type: "toolCall", id: longToolId, name: "foreign-provider", arguments: { ok: true } }], {
						provider: "github-copilot",
					}),
					assistant([]),
					{
						role: "toolResult",
						toolCallId: "call_img|fc_img",
						toolName: "screenshot",
						content: [{ type: "image", mimeType: "image/png", data: "img" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			new Set(["openai"]),
		);

		expect(converted[0]).toMatchObject({ role: "developer", content: "system" });
		expect(converted[1]).toMatchObject({
			role: "user",
			content: [
				{ type: "input_text", text: "hello" },
				{ type: "input_image", image_url: "data:image/png;base64,abcd" },
			],
		});
		expect(converted[2]).toMatchObject({ type: "message", id: "msg_1" });
		expect(converted[3]).toMatchObject({ type: "message", id: "{not-json" });
		expect(converted[4]).toMatchObject({
			type: "function_call",
			id: "fc_existing",
			call_id: "call_1",
		});
		expect(converted[5]).toMatchObject({
			type: "function_call",
			id: "item_without_prefix",
			call_id: "call_prefix",
		});
		expect(converted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function_call",
					id: undefined,
					call_id: "call_2",
				}),
				expect.objectContaining({
					type: "function_call",
					call_id: expect.stringMatching(/^bad(_bad)+$/),
					id: expect.stringMatching(/^fc_[A-Za-z0-9_-]+$/),
				}),
				expect.objectContaining({
					type: "function_call_output",
					call_id: "call_img",
					output: [expect.objectContaining({ type: "input_image", image_url: "data:image/png;base64,img" })],
				}),
			]),
		);
	});

	it("converts response tools with default and nullable strict settings", () => {
		const tools = [
			{
				name: "search",
				description: "Search docs",
				parameters: { type: "object", properties: { query: { type: "string" } } },
			},
		];

		expect(convertResponsesTools(tools)).toMatchObject([{ type: "function", name: "search", strict: false }]);
		expect(convertResponsesTools(tools, { strict: null })).toMatchObject([
			{ type: "function", name: "search", strict: null },
		]);
	});
});

describe("openai responses stream processing", () => {
	it("streams reasoning summaries, refusals, usage, and length stop reasons", async () => {
		const target = model();
		const final = output(target);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(
			responseEvents(
				{
					type: "response.output_item.added",
					item: { type: "reasoning", id: "rs_1", summary: [] },
					output_index: 0,
					sequence_number: 1,
				},
				{
					type: "response.reasoning_summary_part.added",
					item_id: "rs_1",
					output_index: 0,
					part: { type: "summary_text", text: "" },
					sequence_number: 2,
					summary_index: 0,
				},
				{
					type: "response.reasoning_summary_text.delta",
					delta: "summary",
					item_id: "rs_1",
					output_index: 0,
					sequence_number: 3,
					summary_index: 0,
				},
				{
					type: "response.reasoning_summary_part.done",
					item_id: "rs_1",
					output_index: 0,
					part: { type: "summary_text", text: "summary" },
					sequence_number: 4,
					summary_index: 0,
				},
				{
					type: "response.output_item.done",
					item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "summary" }] },
					output_index: 0,
					sequence_number: 5,
				},
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					output_index: 1,
					sequence_number: 6,
				},
				{
					type: "response.content_part.added",
					item_id: "msg_1",
					output_index: 1,
					content_index: 0,
					part: { type: "refusal", refusal: "" },
					sequence_number: 7,
				},
				{
					type: "response.refusal.delta",
					delta: "no",
					item_id: "msg_1",
					output_index: 1,
					content_index: 0,
					sequence_number: 8,
				},
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "refusal", refusal: "no" }],
					},
					output_index: 1,
					sequence_number: 9,
				},
				{
					type: "response.completed",
					response: response({
						id: "resp_1",
						status: "incomplete",
						usage: {
							input_tokens: 5,
							output_tokens: 2,
							total_tokens: 7,
							input_tokens_details: { cached_tokens: 1 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
					}),
					sequence_number: 10,
				},
			),
			final,
			stream,
			target,
		);

		expect(final.stopReason).toBe("length");
		expect(final.responseId).toBe("resp_1");
		expect(final.content).toEqual([
			{
				type: "thinking",
				thinking: "summary",
				thinkingSignature: '{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"summary"}]}',
			},
			{ type: "text", text: "no", textSignature: '{"v":1,"id":"msg_1"}' },
		]);
		expect(final.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1, totalTokens: 7 });
		expect(pushSpy.mock.calls.map(([event]) => event.type)).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
		]);
	});

	it("throws structured provider errors", async () => {
		await expect(
			processResponsesStream(
				responseEvents({
					type: "error",
					code: "rate_limit",
					message: "slow down",
					param: null,
					sequence_number: 1,
				}),
				output(),
				new AssistantMessageEventStream(),
				model(),
			),
		).rejects.toThrow("Error Code rate_limit: slow down");

		await expect(
			processResponsesStream(
				responseEvents({
					type: "response.failed",
					response: response({ error: { code: "invalid_prompt", message: "nope" } }),
					sequence_number: 1,
				}),
				output(),
				new AssistantMessageEventStream(),
				model(),
			),
		).rejects.toThrow("invalid_prompt: nope");

		await expect(
			processResponsesStream(
				responseEvents({
					type: "response.failed",
					response: response({ incomplete_details: { reason: "max_output_tokens" } }),
					sequence_number: 1,
				}),
				output(),
				new AssistantMessageEventStream(),
				model(),
			),
		).rejects.toThrow("incomplete: max_output_tokens");
	});

	it("streams direct reasoning text, output text, tool calls, and service tier pricing", async () => {
		const target = model();
		const final = output(target);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");
		const tiers: Array<string | undefined> = [];

		await processResponsesStream(
			responseEvents(
				{
					type: "response.created",
					response: response({ id: "resp_created" }),
					sequence_number: 1,
				},
				{
					type: "response.output_item.added",
					item: { type: "reasoning", id: "rs_direct", summary: [] },
					output_index: 0,
					sequence_number: 2,
				},
				{
					type: "response.reasoning_text.delta",
					delta: "direct",
					item_id: "rs_direct",
					output_index: 0,
					content_index: 0,
					sequence_number: 3,
				},
				{
					type: "response.output_item.done",
					item: {
						type: "reasoning",
						id: "rs_direct",
						content: [{ type: "reasoning_text", text: "content thinking" }],
						summary: [],
					},
					output_index: 0,
					sequence_number: 4,
				},
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_direct", role: "assistant", status: "in_progress", content: [] },
					output_index: 1,
					sequence_number: 5,
				},
				{
					type: "response.content_part.added",
					item_id: "msg_direct",
					output_index: 1,
					content_index: 0,
					part: { type: "output_text", text: "", annotations: [] },
					sequence_number: 6,
				},
				{
					type: "response.output_text.delta",
					delta: "hello",
					item_id: "msg_direct",
					output_index: 1,
					content_index: 0,
					logprobs: [],
					sequence_number: 7,
				},
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_direct",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "hello", annotations: [] }],
					},
					output_index: 1,
					sequence_number: 8,
				},
				{
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_direct",
						call_id: "call_direct",
						name: "search",
						arguments: '{"query":',
					},
					output_index: 2,
					sequence_number: 9,
				},
				{
					type: "response.function_call_arguments.delta",
					delta: '"docs"',
					item_id: "fc_direct",
					output_index: 2,
					sequence_number: 10,
				},
				{
					type: "response.function_call_arguments.done",
					arguments: '{"query":"docs","limit":1}',
					item_id: "fc_direct",
					name: "search",
					output_index: 2,
					sequence_number: 11,
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_direct",
						call_id: "call_direct",
						name: "search",
						arguments: '{"query":"docs","limit":1}',
					},
					output_index: 2,
					sequence_number: 12,
				},
				{
					type: "response.completed",
					response: response({
						id: "resp_done",
						status: "completed",
						service_tier: "priority",
						usage: {
							input_tokens: 8,
							output_tokens: 4,
							total_tokens: 12,
							input_tokens_details: { cached_tokens: 2 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
					}),
					sequence_number: 13,
				},
			),
			final,
			stream,
			target,
			{
				serviceTier: "default",
				resolveServiceTier: (responseTier, requestTier) => {
					tiers.push(`${responseTier ?? "none"}:${requestTier ?? "none"}`);
					return responseTier ?? requestTier;
				},
				applyServiceTierPricing: () => {},
			},
		);

		expect(final.responseId).toBe("resp_done");
		expect(final.stopReason).toBe("toolUse");
		expect(final.content).toEqual([
			{
				type: "thinking",
				thinking: "content thinking",
				thinkingSignature:
					'{"type":"reasoning","id":"rs_direct","content":[{"type":"reasoning_text","text":"content thinking"}],"summary":[]}',
			},
			{ type: "text", text: "hello", textSignature: '{"v":1,"id":"msg_direct"}' },
			{ type: "toolCall", id: "call_direct|fc_direct", name: "search", arguments: { query: "docs", limit: 1 } },
		]);
		expect(final.usage).toMatchObject({ input: 6, output: 4, cacheRead: 2, totalTokens: 12 });
		expect(tiers).toEqual(["priority:default"]);
		expect(pushSpy.mock.calls.map(([event]) => event.type)).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
	});

	it("streams sparse provider events with defaults", async () => {
		const target = model();
		const final = output(target);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(
			responseEvents(
				providerWireEvent({
					type: "response.output_item.added",
					item: { type: "reasoning", id: "rs_sparse" },
					output_index: 0,
					sequence_number: 1,
				}),
				{
					type: "response.reasoning_summary_part.added",
					item_id: "rs_sparse",
					output_index: 0,
					part: { type: "summary_text", text: "" },
					sequence_number: 2,
					summary_index: 0,
				},
				{
					type: "response.reasoning_summary_text.delta",
					delta: "sparse",
					item_id: "rs_sparse",
					output_index: 0,
					sequence_number: 3,
					summary_index: 0,
				},
				providerWireEvent({
					type: "response.output_item.done",
					item: { type: "reasoning", id: "rs_sparse" },
					output_index: 0,
					sequence_number: 4,
				}),
				providerWireEvent({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_phase", role: "assistant", status: "in_progress" },
					output_index: 1,
					sequence_number: 5,
				}),
				{
					type: "response.content_part.added",
					item_id: "msg_phase",
					output_index: 1,
					content_index: 0,
					part: { type: "output_text", text: "", annotations: [] },
					sequence_number: 6,
				},
				{
					type: "response.output_text.delta",
					delta: "phased",
					item_id: "msg_phase",
					output_index: 1,
					content_index: 0,
					logprobs: [],
					sequence_number: 7,
				},
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_phase",
						role: "assistant",
						status: "completed",
						phase: "commentary",
						content: [{ type: "output_text", text: "phased", annotations: [] }],
					},
					output_index: 1,
					sequence_number: 8,
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_empty_args",
						call_id: "call_empty_args",
						name: "empty_args",
						arguments: "",
					},
					output_index: 2,
					sequence_number: 9,
				},
				{
					type: "response.completed",
					response: response({
						id: "resp_sparse",
						status: "completed",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							total_tokens: 0,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
					}),
					sequence_number: 10,
				},
			),
			final,
			stream,
			target,
		);

		expect(final.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "sparse" }),
			{ type: "text", text: "phased", textSignature: '{"v":1,"id":"msg_phase","phase":"commentary"}' },
		]);
		expect(final.usage).toMatchObject({ input: 0, output: 0, totalTokens: 0 });
		expect(pushSpy.mock.calls.map(([event]) => event.type)).toContain("toolcall_end");
	});

	it("handles completed tool calls without a preceding added event", async () => {
		const final = output();
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(
			responseEvents({
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_late",
					call_id: "call_late",
					name: "late",
					arguments: '{"ok":true}',
				},
				output_index: 0,
				sequence_number: 1,
			}),
			final,
			stream,
			model(),
		);

		expect(pushSpy).toHaveBeenCalledWith({
			type: "toolcall_end",
			contentIndex: -1,
			toolCall: { type: "toolCall", id: "call_late|fc_late", name: "late", arguments: { ok: true } },
			partial: final,
		});
	});

	it("ignores text and refusal deltas before a content part is present", async () => {
		const final = output();
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(
			responseEvents(
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_empty", role: "assistant", status: "in_progress", content: [] },
					output_index: 0,
					sequence_number: 1,
				},
				{
					type: "response.output_text.delta",
					delta: "ignored",
					item_id: "msg_empty",
					output_index: 0,
					content_index: 0,
					logprobs: [],
					sequence_number: 2,
				},
				{
					type: "response.refusal.delta",
					delta: "also ignored",
					item_id: "msg_empty",
					output_index: 0,
					content_index: 0,
					sequence_number: 3,
				},
			),
			final,
			stream,
			model(),
		);

		expect(final.content).toEqual([{ type: "text", text: "" }]);
		expect(pushSpy.mock.calls.map(([event]) => event.type)).toEqual(["text_start"]);
	});

	it("maps completed response statuses and missing failure details", async () => {
		for (const [status, expected] of [
			["failed", "error"],
			["cancelled", "error"],
			["in_progress", "stop"],
			["queued", "stop"],
			[undefined, "stop"],
		] as const) {
			const final = output();
			await processResponsesStream(
				responseEvents({
					type: "response.completed",
					response: response({ status }),
					sequence_number: 1,
				}),
				final,
				new AssistantMessageEventStream(),
				model(),
			);
			expect(final.stopReason).toBe(expected);
		}

		await expect(
			processResponsesStream(
				responseEvents({
					type: "response.failed",
					response: response(),
					sequence_number: 1,
				}),
				output(),
				new AssistantMessageEventStream(),
				model(),
			),
		).rejects.toThrow("Unknown error (no error details in response)");

		await expect(
			processResponsesStream(
				responseEvents({
					type: "response.failed",
					response: response({ error: {} as Response["error"] }),
					sequence_number: 1,
				}),
				output(),
				new AssistantMessageEventStream(),
				model(),
			),
		).rejects.toThrow("unknown: no message");

		await expect(
			processResponsesStream(
				responseEvents({
					type: "response.completed",
					response: response({ status: "unexpected-status" as Response["status"] }),
					sequence_number: 1,
				}),
				output(),
				new AssistantMessageEventStream(),
				model(),
			),
		).rejects.toThrow("Unhandled stop reason: unexpected-status");
	});
});
