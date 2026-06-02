import { describe, expect, it, vi } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../src/types.js";

function model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "target-model",
		name: "Target Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 64_000,
		...overrides,
	};
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "target-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function toolCall(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
	return {
		type: "toolCall",
		id,
		name: "edit",
		arguments: { path: "README.md" },
		...overrides,
	};
}

function toolResult(toolCallId: string, content: ToolResultMessage["content"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "edit",
		content,
		isError: false,
		timestamp: 2,
	};
}

describe("transformMessages", () => {
	it("downgrades unsupported user and tool-result images without duplicating adjacent placeholders", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "before" },
					{ type: "image", mimeType: "image/png", data: "a" },
					{ type: "image", mimeType: "image/png", data: "b" },
					{ type: "text", text: "after" },
				],
				timestamp: 1,
			},
			toolResult("call_1", [
				{ type: "image", mimeType: "image/jpeg", data: "c" },
				{ type: "image", mimeType: "image/jpeg", data: "d" },
				{ type: "text", text: "done" },
			]),
		];

		expect(transformMessages(messages, model())).toMatchObject([
			{
				role: "user",
				content: [
					{ type: "text", text: "before" },
					{ type: "text", text: "(image omitted: model does not support images)" },
					{ type: "text", text: "after" },
				],
			},
			{
				role: "toolResult",
				content: [
					{ type: "text", text: "(tool image omitted: model does not support images)" },
					{ type: "text", text: "done" },
				],
			},
		]);

		expect(transformMessages(messages, model({ input: ["text", "image"] }))).toMatchObject(messages);
	});

	it("normalizes cross-model assistant content while preserving same-model replay metadata", () => {
		const sameModel = assistant([
			{ type: "thinking", thinking: "", thinkingSignature: "encrypted", redacted: true },
			{ type: "thinking", thinking: "kept", thinkingSignature: "sig" },
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "answer", textSignature: "msg_1" },
			toolCall("call_same", { thoughtSignature: "thought" }),
		]);
		const foreignTool = toolCall("foreign|tool", { thoughtSignature: "foreign-thought" });
		const foreign = assistant(
			[
				{ type: "thinking", thinking: "foreign thinking", redacted: true },
				{ type: "thinking", thinking: "plain thinking" },
				{ type: "text", text: "foreign text", textSignature: "foreign-msg" },
				foreignTool,
			],
			{
				api: "openai-responses",
				provider: "github-copilot",
				model: "other-model",
			},
		);
		const result = transformMessages(
			[sameModel, foreign, toolResult("foreign|tool", [{ type: "text", text: "ok" }])],
			model(),
			(id) => `normalized-${id.replace(/\W/g, "-")}`,
		);

		expect(result[0]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: "encrypted", redacted: true },
				{ type: "thinking", thinking: "kept", thinkingSignature: "sig" },
				{ type: "text", text: "answer", textSignature: "msg_1" },
				{ type: "toolCall", id: "call_same", thoughtSignature: "thought" },
			],
		});
		expect(result[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_same",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
		expect(result[2]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "text", text: "plain thinking" },
				{ type: "text", text: "foreign text" },
				{ type: "toolCall", id: "normalized-foreign-tool" },
			],
		});
		expect(result[2]).not.toMatchObject({
			content: [expect.objectContaining({ redacted: true })],
		});
		expect(result[2]).not.toMatchObject({
			content: [expect.objectContaining({ thoughtSignature: "foreign-thought" })],
		});
		expect(result[3]).toMatchObject({
			role: "toolResult",
			toolCallId: "normalized-foreign-tool",
		});
	});

	it("inserts synthetic tool results before interruptions and skips incomplete assistant turns", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_234);
		try {
			const pending = assistant([toolCall("pending")]);
			const answered = assistant([toolCall("answered")]);
			const failed = assistant([{ type: "text", text: "partial" }], { stopReason: "error" });
			const aborted = assistant([{ type: "text", text: "partial" }], { stopReason: "aborted" });
			const messages: Message[] = [
				pending,
				{ role: "user", content: "interrupt", timestamp: 2 },
				answered,
				toolResult("answered", [{ type: "text", text: "real result" }]),
				failed,
				aborted,
			];

			expect(transformMessages(messages, model())).toMatchObject([
				{ role: "assistant", content: [{ type: "toolCall", id: "pending" }] },
				{
					role: "toolResult",
					toolCallId: "pending",
					toolName: "edit",
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: 1_234,
				},
				{ role: "user", content: "interrupt" },
				{ role: "assistant", content: [{ type: "toolCall", id: "answered" }] },
				{ role: "toolResult", toolCallId: "answered", content: [{ type: "text", text: "real result" }] },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("passes through unknown message roles and assistant content blocks", () => {
		const customBlock = { type: "custom", value: 1 } as unknown as AssistantMessage["content"][number];
		const customMessage = { role: "custom", content: "legacy", timestamp: 3 } as unknown as Message;
		const messages: Message[] = [assistant([customBlock]), customMessage];

		expect(transformMessages(messages, model({ input: ["text", "image"] }))).toEqual(messages);
	});
});
