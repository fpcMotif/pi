import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoopContinue } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			const reason = message.stopReason;
			if (reason === "error" || reason === "aborted") {
				this.push({ type: "error", reason, error: message });
			} else {
				this.push({ type: "done", reason, message });
			}
		});
	}
}

class EndingAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage, options: { startBeforeEnd?: boolean } = {}) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			if (options.startBeforeEnd) this.push({ type: "start", partial: message });
			this.end(message);
		});
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((message) => {
		return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
	}) as Message[];
}

function throwNonError(value: unknown): never {
	throw value;
}

async function collectEvents(context: AgentContext, config: AgentLoopConfig): Promise<AgentEvent[]> {
	let calls = 0;
	const stream = agentLoop([createUserMessage("run tool")], context, config, undefined, () => {
		calls++;
		if (calls === 1) {
			return new MockAssistantStream(
				createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: 1 } }],
					"toolUse",
				),
			);
		}
		return new MockAssistantStream(createAssistantMessage([{ type: "text", text: "done" }]));
	});
	const events: AgentEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("agentLoop tool error paths", () => {
	it("validates continue entrypoints for assistant last messages", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [createAssistantMessage([{ type: "text", text: "done" }])],
			tools: [],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue from message role: assistant");
		await expect(runAgentLoopContinue(context, config, async () => {})).rejects.toThrow(
			"Cannot continue from message role: assistant",
		);
		await expect(runAgentLoopContinue({ ...context, messages: [] }, config, async () => {})).rejects.toThrow(
			"Cannot continue: no messages in context",
		);
	});

	it("finalizes assistant streams that end without a terminal event", async () => {
		const user = createUserMessage("run");
		const message = createAssistantMessage([{ type: "text", text: "ended" }]);
		const stream = agentLoop(
			[user],
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => new EndingAssistantStream(message),
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(await stream.result()).toEqual([user, message]);
		expect(events).toContainEqual({ type: "message_start", message });
		expect(events).toContainEqual({ type: "message_end", message });
	});

	it("replaces partial assistant messages when streams start and then end", async () => {
		const message = createAssistantMessage([{ type: "text", text: "started then ended" }]);
		const stream = agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => new EndingAssistantStream(message, { startBeforeEnd: true }),
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect((await stream.result()).at(-1)).toEqual(message);
		expect(events).toContainEqual({ type: "message_start", message: { ...message } });
		expect(events).toContainEqual({ type: "message_end", message });
	});

	it("returns an error tool result when the requested tool is missing", async () => {
		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: createModel(), convertToLlm: identityConverter },
		);

		const toolEnd = events.find((event) => event.type === "tool_execution_end");
		const toolResult = events.find((event) => event.type === "message_end" && event.message.role === "toolResult");

		expect(toolEnd).toMatchObject({ type: "tool_execution_end", isError: true });
		expect(toolResult).toMatchObject({
			type: "message_end",
			message: {
				role: "toolResult",
				isError: true,
				content: [{ type: "text", text: "Tool echo not found" }],
			},
		});
	});

	it("returns immediate sequential tool errors before execution", async () => {
		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [] },
			{ model: createModel(), convertToLlm: identityConverter, toolExecution: "sequential" },
		);

		expect(events.find((event) => event.type === "tool_execution_end")).toMatchObject({
			type: "tool_execution_end",
			isError: true,
		});
	});

	it("returns an error tool result when validation fails before execution", async () => {
		const schema = Type.Object({ required: Type.String() });
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: params.required }],
					details: { value: params.required },
				};
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
		);

		const toolResult = events.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		expect(toolResult).toMatchObject({
			type: "message_end",
			message: { role: "toolResult", isError: true },
		});
	});

	it("uses the default block reason when a before hook blocks without a reason", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: String(params.value) }],
					details: { value: params.value },
				};
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => ({ block: true }),
			},
		);

		expect(events.find((event) => event.type === "message_end" && event.message.role === "toolResult")).toMatchObject(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: "Tool execution was blocked" }],
				},
			},
		);
	});

	it("stringifies non-error before hook failures", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: String(params.value) }],
					details: { value: params.value },
				};
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => {
					throwNonError("before string");
				},
			},
		);

		expect(events.find((event) => event.type === "message_end" && event.message.role === "toolResult")).toMatchObject(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: "before string" }],
				},
			},
		);
	});

	it("allows before and after hooks to block or override tool results", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { value: params.value } });
				return {
					content: [{ type: "text", text: String(params.value) }],
					details: { value: params.value },
				};
			},
		};

		const blockedEvents = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				beforeToolCall: async () => ({ block: true, reason: "blocked by test" }),
			},
		);
		expect(
			blockedEvents.find((event) => event.type === "message_end" && event.message.role === "toolResult"),
		).toMatchObject({
			type: "message_end",
			message: {
				role: "toolResult",
				isError: true,
				content: [{ type: "text", text: "blocked by test" }],
			},
		});

		const overriddenEvents = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				afterToolCall: async () => ({
					content: [{ type: "text", text: "overridden" }],
					details: { patched: true },
					isError: true,
					terminate: true,
				}),
			},
		);
		expect(overriddenEvents.some((event) => event.type === "tool_execution_update")).toBe(true);
		expect(
			overriddenEvents.find((event) => event.type === "message_end" && event.message.role === "toolResult"),
		).toMatchObject({
			type: "message_end",
			message: {
				role: "toolResult",
				isError: true,
				content: [{ type: "text", text: "overridden" }],
				details: { patched: true },
			},
		});
		expect(overriddenEvents.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("converts thrown afterToolCall errors into error tool results", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: String(params.value) }],
					details: { value: params.value },
				};
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				afterToolCall: async () => {
					throw new Error("after hook failed");
				},
			},
		);

		expect(events.find((event) => event.type === "message_end" && event.message.role === "toolResult")).toMatchObject(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: "after hook failed" }],
				},
			},
		);
	});

	it("stringifies non-error after hook failures", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: String(params.value) }],
					details: { value: params.value },
				};
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				afterToolCall: async () => {
					throwNonError("after string");
				},
			},
		);

		expect(events.find((event) => event.type === "message_end" && event.message.role === "toolResult")).toMatchObject(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: "after string" }],
				},
			},
		);
	});

	it("retains original result fields when an after hook returns only a partial override", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: String(params.value) }],
					details: { value: params.value },
					terminate: true,
				};
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				afterToolCall: async () => ({ details: { patched: true } }),
			},
		);

		expect(events.find((event) => event.type === "message_end" && event.message.role === "toolResult")).toMatchObject(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					isError: false,
					content: [{ type: "text", text: "1" }],
					details: { patched: true },
				},
			},
		);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("keeps unchanged prepared arguments and reports thrown tool execution errors", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			prepareArguments(args) {
				return args as { value: number };
			},
			async execute() {
				throw new Error("tool failed");
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
		);

		expect(events.find((event) => event.type === "message_end" && event.message.role === "toolResult")).toMatchObject(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: "tool failed" }],
				},
			},
		);
	});

	it("stringifies non-error tool execution failures", async () => {
		const schema = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof schema, { value: number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute() {
				throwNonError("tool string");
			},
		};

		const events = await collectEvents(
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: createModel(), convertToLlm: identityConverter },
		);

		expect(events.find((event) => event.type === "message_end" && event.message.role === "toolResult")).toMatchObject(
			{
				type: "message_end",
				message: {
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: "tool string" }],
				},
			},
		);
	});
});
