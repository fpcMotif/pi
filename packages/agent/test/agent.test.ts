import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { AgentEvent, AgentMessage, AgentTool } from "../src/types.js";

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

class ManualAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}

	finish(message: AssistantMessage): void {
		const reason = message.stopReason;
		if (reason === "error" || reason === "aborted") {
			this.push({ type: "error", reason, error: message });
		} else {
			this.push({ type: "done", reason, message });
		}
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

function createUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
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

describe("Agent", () => {
	it("copies mutable state arrays and clears runtime queues on reset", () => {
		const model = createModel();
		const message = createUserMessage("hello");
		const tool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: {} as AgentTool["parameters"],
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		} satisfies AgentTool;
		const messages: AgentMessage[] = [message];
		const tools: AgentTool[] = [tool];
		const agent = new Agent({
			initialState: {
				model,
				messages,
				tools,
				systemPrompt: "system",
				thinkingLevel: "high",
			},
		});

		messages.push(createUserMessage("mutated"));
		tools.push({ ...tool, name: "other" });

		expect(agent.state.messages).toEqual([message]);
		expect(agent.state.tools).toEqual([tool]);

		const nextMessages = [createUserMessage("assigned")];
		const nextTools = [{ ...tool, name: "assigned" }];
		agent.state.messages = nextMessages;
		agent.state.tools = nextTools;
		nextMessages.push(createUserMessage("after assignment"));
		nextTools.push({ ...tool, name: "after-assignment" });

		expect(agent.state.messages).toHaveLength(1);
		expect(agent.state.tools).toHaveLength(1);

		agent.steer(createUserMessage("steer"));
		agent.followUp(createUserMessage("follow"));
		expect(agent.hasQueuedMessages()).toBe(true);

		agent.reset();

		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBeUndefined();
		expect(agent.state.pendingToolCalls.size).toBe(0);
		expect(agent.state.errorMessage).toBeUndefined();
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("continues from an assistant message by draining queued steering before follow-ups", async () => {
		const seenPrompts: string[] = [];
		const agent = new Agent({
			initialState: {
				model: createModel(),
				messages: [createAssistantMessage("ready")],
			},
			streamFn: async (_model, context) => {
				const lastMessage = context.messages[context.messages.length - 1];
				seenPrompts.push(lastMessage?.role === "user" ? String(lastMessage.content) : (lastMessage?.role ?? ""));
				return new MockAssistantStream(createAssistantMessage(`response ${seenPrompts.length}`));
			},
		});

		agent.steer(createUserMessage("steer-1"));
		agent.steer(createUserMessage("steer-2"));
		agent.followUp(createUserMessage("follow-1"));

		await agent.continue();

		expect(seenPrompts).toEqual(["steer-1", "steer-2", "follow-1"]);
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("exposes queue modes, busy guards, and explicit queue clearing", async () => {
		let stream: ManualAssistantStream | undefined;
		const agent = new Agent({
			initialState: { model: createModel() },
			streamFn: async () => {
				stream = new ManualAssistantStream();
				return stream;
			},
		});

		agent.steeringMode = "all";
		agent.followUpMode = "all";
		expect(agent.steeringMode).toBe("all");
		expect(agent.followUpMode).toBe("all");

		const promptPromise = agent.prompt("busy");
		expect(agent.signal?.aborted).toBe(false);
		await expect(agent.prompt("second")).rejects.toThrow("Agent is already processing a prompt");
		await expect(agent.continue()).rejects.toThrow("Agent is already processing");

		agent.steer(createUserMessage("steer"));
		agent.followUp(createUserMessage("follow"));
		expect(agent.hasQueuedMessages()).toBe(true);
		agent.clearSteeringQueue();
		expect(agent.hasQueuedMessages()).toBe(true);
		agent.clearFollowUpQueue();
		expect(agent.hasQueuedMessages()).toBe(false);

		stream?.finish(createAssistantMessage("done"));
		await promptPromise;
		await expect(agent.waitForIdle()).resolves.toBeUndefined();
	});

	it("normalizes prompt input variants and continues from user messages", async () => {
		const seenLastRoles: string[] = [];
		const seenLastContent: string[] = [];
		const agent = new Agent({
			initialState: { model: createModel() },
			streamFn: async (_model, context) => {
				const last = context.messages.at(-1);
				seenLastRoles.push(last?.role ?? "");
				seenLastContent.push(last?.role === "user" ? String(last.content) : "");
				return new MockAssistantStream(createAssistantMessage(`reply ${seenLastRoles.length}`));
			},
		});

		await agent.prompt(createUserMessage("single"));
		await agent.prompt([createUserMessage("array")]);
		await agent.prompt("with image", [{ type: "image", mimeType: "image/png", data: "abc" }]);
		agent.state.messages = [createUserMessage("continue user")];
		await agent.continue();

		expect(seenLastRoles).toEqual(["user", "user", "user", "user"]);
		expect(seenLastContent[0]).toBe("single");
		expect(seenLastContent[1]).toBe("array");
		expect(seenLastContent[2]).toBe("[object Object],[object Object]");
		expect(seenLastContent[3]).toBe("continue user");
	});

	it("records a failed run as an assistant error message", async () => {
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { model: createModel() },
			streamFn: async () => {
				throw new Error("provider exploded");
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});

		await agent.prompt("hello");

		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.errorMessage).toBe("provider exploded");
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "provider exploded",
		});
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("rejects invalid continuation states", async () => {
		const agent = new Agent({ initialState: { model: createModel() } });
		await expect(agent.continue()).rejects.toThrow("No messages to continue from");

		agent.state.messages = [createAssistantMessage("done")];
		await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
	});
});
