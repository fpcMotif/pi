import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.js";
import { NodeExecutionEnv } from "../../src/harness/execution-env.js";
import { Session } from "../../src/harness/session/session.js";
import { InMemorySessionStorage } from "../../src/harness/session/storage/memory.js";
import type { AgentHarnessEvent, PromptTemplate, Skill } from "../../src/harness/types.js";
import type { AgentMessage, AgentTool, ThinkingLevel } from "../../src/types.js";

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
	while (registrations.length > 0) {
		registrations.pop()?.unregister();
	}
});

function registerProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return registration;
}

function createSession(): Session {
	return new Session(new InMemorySessionStorage({ metadata: { id: "session-1", createdAt: "now" } }));
}

function createHarness(
	options: Partial<ConstructorParameters<typeof AgentHarness>[0]> & {
		model: Model<any>;
		session?: Session;
	},
): AgentHarness {
	return new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: options.session ?? createSession(),
		...options,
		model: options.model,
	});
}

function textFromMessage(message: AgentMessage): string {
	const content = "content" in message ? message.content : "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

describe("AgentHarness", () => {
	it("prepares prompt turns with resources, before-start hooks, and next-turn messages", async () => {
		const registration = registerProvider();
		const contexts: Array<{ systemPrompt?: string; messages: AgentMessage[] }> = [];
		registration.setResponses([
			(context) => {
				contexts.push({ systemPrompt: context.systemPrompt, messages: context.messages as AgentMessage[] });
				return fauxAssistantMessage("prompt ok");
			},
		]);
		const skill: Skill = {
			name: "cleanup",
			description: "Clean up code",
			content: "Cleanup instructions",
			filePath: "C:/skills/cleanup/SKILL.md",
		};
		const promptTemplate: PromptTemplate = {
			name: "commit",
			description: "Commit prompt",
			content: "Commit $1 with $@",
		};
		const queueUpdates: Array<Extract<AgentHarnessEvent, { type: "queue_update" }>> = [];
		const harness = createHarness({
			model: registration.getModel(),
			thinkingLevel: "medium",
			resources: { skills: [skill], promptTemplates: [promptTemplate] },
			systemPrompt: ({ activeTools, resources, thinkingLevel }) => {
				expect(activeTools).toEqual([]);
				expect(resources.skills?.[0]).toEqual(skill);
				expect(thinkingLevel).toBe("medium");
				return "generated system";
			},
		});
		harness.subscribe((event) => {
			if (event.type === "queue_update") queueUpdates.push(event);
		});
		harness.on("before_agent_start", (event) => {
			expect(event.prompt).toBe("main prompt");
			expect(event.systemPrompt).toBe("generated system");
			expect(event.resources.skills?.[0]?.name).toBe("cleanup");
			return {
				systemPrompt: "hooked system",
				messages: [{ role: "user", content: "prepended", timestamp: Date.now() }],
			};
		});

		harness.nextTurn("queued", {
			images: [{ type: "image", mimeType: "image/png", data: "queued-image" }],
		});
		const response = await harness.prompt("main prompt", {
			images: [{ type: "image", mimeType: "image/png", data: "abc" }],
		});

		expect(assistantText(response)).toBe("prompt ok");
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.systemPrompt).toBe("hooked system");
		expect(contexts[0]?.messages.map(textFromMessage)).toEqual(["prepended", "queued", "main prompt"]);
		expect(queueUpdates[0]?.nextTurn.map(textFromMessage)).toEqual(["queued"]);
		expect(queueUpdates.at(-1)?.nextTurn).toEqual([]);

		const resources = harness.getResources();
		resources.skills?.push({ ...skill, name: "mutated" });
		expect(harness.getResources().skills?.map((entry) => entry.name)).toEqual(["cleanup"]);
	});

	it("invokes skills and prompt templates explicitly", async () => {
		const registration = registerProvider();
		const prompts: string[] = [];
		registration.setResponses([
			(context) => {
				prompts.push(textFromMessage(context.messages.at(-1) as AgentMessage));
				return fauxAssistantMessage("skill ok");
			},
			(context) => {
				prompts.push(textFromMessage(context.messages.at(-1) as AgentMessage));
				return fauxAssistantMessage("template ok");
			},
		]);
		const skill: Skill = {
			name: "cleanup",
			description: "Clean up code",
			content: "Cleanup instructions",
			filePath: "C:/skills/cleanup/SKILL.md",
		};
		const promptTemplate: PromptTemplate = {
			name: "commit",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: $1, ${@:2:1}, $ARGUMENTS are prompt-template placeholders, not JS expressions
			content: "Commit $1 and ${@:2:1} with $ARGUMENTS",
		};
		const harness = createHarness({
			model: registration.getModel(),
			resources: { skills: [skill], promptTemplates: [promptTemplate] },
		});

		await expect(harness.skill("missing")).rejects.toThrow("Unknown skill: missing");
		await expect(harness.promptFromTemplate("missing")).rejects.toThrow("Unknown prompt template: missing");

		expect(assistantText(await harness.skill("cleanup", "Use tests."))).toBe("skill ok");
		expect(assistantText(await harness.promptFromTemplate("commit", ["fix", "coverage"]))).toBe("template ok");

		expect(prompts[0]).toContain('<skill name="cleanup" location="C:/skills/cleanup/SKILL.md">');
		expect(prompts[0]).toContain("Use tests.");
		expect(prompts[1]).toBe("Commit fix and coverage with fix coverage");
	});

	it("queues active-turn mutations and flushes them at save points", async () => {
		const registration = registerProvider();
		registration.setResponses([fauxAssistantMessage("done")]);
		const session = createSession();
		const events: AgentHarnessEvent[] = [];
		const harness = createHarness({
			model: registration.getModel(),
			session,
		});
		harness.subscribe(async (event) => {
			events.push(event);
			if (event.type === "message_start" && event.message.role === "assistant") {
				await harness.appendMessage({ role: "user", content: "pending message", timestamp: Date.now() });
				await harness.setModel({ ...registration.getModel(), id: "next-model" });
				await harness.setThinkingLevel("high");
			}
		});

		expect(() => harness.steer("idle steer")).toThrow("Cannot steer while idle");
		expect(() => harness.followUp("idle follow")).toThrow("Cannot follow up while idle");

		await harness.prompt("start");

		const entries = await session.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"message",
			"message",
			"message",
			"model_change",
			"thinking_level_change",
		]);
		expect(events).toContainEqual({ type: "save_point", hadPendingMutations: true });
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "model_select",
				model: expect.objectContaining({ id: "next-model" }),
				source: "set",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "thinking_level_select",
				level: "high" satisfies ThinkingLevel,
			}),
		);
	});

	it("updates resources, stream options, and active tools defensively", async () => {
		const registration = registerProvider();
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: {} as AgentTool["parameters"],
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const events: AgentHarnessEvent[] = [];
		const harness = createHarness({
			model: registration.getModel(),
			tools: [tool],
			activeToolNames: ["noop"],
			streamOptions: { headers: { original: "1" }, metadata: { original: true } },
		});
		harness.subscribe((event) => {
			events.push(event);
		});

		const streamOptions = harness.getStreamOptions();
		streamOptions.headers!.original = "mutated";
		streamOptions.metadata = { mutated: true };
		expect(harness.getStreamOptions()).toEqual({ headers: { original: "1" }, metadata: { original: true } });

		harness.setStreamOptions({ headers: { next: "1" }, metadata: { next: true } });
		expect(harness.getStreamOptions()).toEqual({ headers: { next: "1" }, metadata: { next: true } });
		harness.setStreamOptions({ headers: undefined, metadata: undefined });
		expect(harness.getStreamOptions()).toEqual({ headers: undefined, metadata: undefined });

		await expect(harness.setActiveTools(["missing"])).rejects.toThrow("Unknown tool(s): missing");
		await harness.setActiveTools([]);
		await expect(harness.setTools([], ["noop"])).rejects.toThrow("Unknown tool(s): noop");
		await harness.setTools([tool], ["noop"]);
		await harness.setTools([tool]);
		await harness.setModel({ ...registration.getModel(), id: "idle-model" });
		await harness.setThinkingLevel("low");
		harness.steeringMode = "all";
		harness.followUpMode = "all";
		expect(harness.steeringMode).toBe("all");
		expect(harness.followUpMode).toBe("all");

		await harness.setResources({ promptTemplates: [{ name: "next", content: "Next" }] });
		await harness.setResources({
			skills: [
				{
					name: "lint",
					description: "Lint code",
					content: "Run lint",
					filePath: "C:/skills/lint/SKILL.md",
				},
			],
		});

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "resources_update",
				resources: { promptTemplates: [{ name: "next", content: "Next" }], skills: undefined },
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "resources_update",
				resources: {
					skills: [
						{
							name: "lint",
							description: "Lint code",
							content: "Run lint",
							filePath: "C:/skills/lint/SKILL.md",
						},
					],
					promptTemplates: undefined,
				},
			}),
		);
	});

	it("uses static system prompts when preparing a turn", async () => {
		const registration = registerProvider();
		const systemPrompts: Array<string | undefined> = [];
		const streamHeaders: Array<Record<string, string> | undefined> = [];
		registration.setResponses([
			(context, options) => {
				systemPrompts.push(context.systemPrompt);
				streamHeaders.push(options?.headers);
				return fauxAssistantMessage("done");
			},
		]);
		const harness = createHarness({
			model: registration.getModel(),
			systemPrompt: "static system",
			streamOptions: { headers: { original: "1" }, metadata: { original: true } },
		});
		harness.on("before_provider_request", () => ({
			streamOptions: { headers: undefined, metadata: undefined },
		}));

		await harness.prompt("start");

		expect(systemPrompts).toEqual(["static system"]);
		expect(streamHeaders).toEqual([undefined]);
	});

	it("allows context hooks to replace messages before provider conversion", async () => {
		const registration = registerProvider();
		const prompts: string[] = [];
		registration.setResponses([
			(context) => {
				prompts.push(textFromMessage(context.messages.at(-1) as AgentMessage));
				return fauxAssistantMessage("done");
			},
		]);
		const harness = createHarness({ model: registration.getModel() });
		harness.on("context", (event) => {
			expect(event.messages.map(textFromMessage)).toEqual(["original"]);
			return { messages: [{ role: "user", content: "hooked", timestamp: Date.now() }] };
		});

		await harness.prompt("original");

		expect(prompts).toEqual(["hooked"]);
	});

	it("appends idle messages and resets phase after prompt preparation errors", async () => {
		const registration = registerProvider();
		const session = createSession();
		const harness = createHarness({
			model: registration.getModel(),
			session,
		});
		await harness.appendMessage({ role: "user", content: "idle message", timestamp: Date.now() });
		harness.on("before_agent_start", () => {
			throw new Error("before start failed");
		});

		await expect(harness.prompt("will fail")).rejects.toThrow("before start failed");

		expect(await session.getEntries()).toHaveLength(1);
	});

	it("resets phase after malformed providers produce no assistant response", async () => {
		const registration = registerProvider();
		registration.setResponses([
			{ ...fauxAssistantMessage("not assistant"), role: "user" } as unknown as AssistantMessage,
			fauxAssistantMessage("recovered"),
		]);
		const harness = createHarness({ model: registration.getModel() });

		await expect(harness.prompt("will fail")).rejects.toThrow(
			"AgentHarness prompt completed without an assistant message",
		);
		expect(assistantText(await harness.prompt("after failure"))).toBe("recovered");
	});

	it("uses empty resources when explicit invocation targets are missing", async () => {
		const registration = registerProvider();
		const harness = createHarness({ model: registration.getModel() });

		await expect(harness.skill("missing")).rejects.toThrow("Unknown skill: missing");
		await expect(harness.promptFromTemplate("missing")).rejects.toThrow("Unknown prompt template: missing");
	});

	it("rejects turn-only operations while a prompt is active", async () => {
		const registration = registerProvider();
		registration.setResponses([fauxAssistantMessage("done")]);
		const session = createSession();
		const targetId = await session.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = createHarness({
			model: registration.getModel(),
			session,
			resources: {
				skills: [
					{
						name: "cleanup",
						description: "Clean up code",
						content: "Cleanup instructions",
						filePath: "C:/skills/cleanup/SKILL.md",
					},
				],
				promptTemplates: [{ name: "commit", content: "Commit $1" }],
			},
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		harness.on("before_provider_request", async () => {
			await gate;
			return {};
		});

		const promptPromise = harness.prompt("busy");

		await expect(harness.prompt("second")).rejects.toThrow("AgentHarness is busy");
		await expect(harness.skill("cleanup")).rejects.toThrow("AgentHarness is busy");
		await expect(harness.promptFromTemplate("commit")).rejects.toThrow("AgentHarness is busy");
		await expect(harness.compact()).rejects.toThrow("compact() requires idle harness");
		await expect(harness.navigateTree(targetId)).rejects.toThrow("navigateTree() requires idle harness");

		release();
		await promptPromise;
	});

	it("queues follow-up messages while a provider request is active", async () => {
		const registration = registerProvider();
		const prompts: string[] = [];
		registration.setResponses([
			(context) => {
				prompts.push(textFromMessage(context.messages.at(-1) as AgentMessage));
				return fauxAssistantMessage("initial");
			},
			(context) => {
				prompts.push(textFromMessage(context.messages.at(-1) as AgentMessage));
				return fauxAssistantMessage("followed");
			},
		]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let requestCount = 0;
		let firstRequestStarted!: () => void;
		const firstRequest = new Promise<void>((resolve) => {
			firstRequestStarted = resolve;
		});
		const harness = createHarness({ model: registration.getModel() });
		harness.on("before_provider_request", async () => {
			requestCount++;
			if (requestCount === 1) {
				firstRequestStarted();
				await gate;
			}
			return {};
		});

		const promptPromise = harness.prompt("initial prompt");
		await firstRequest;
		harness.followUp("follow active", {
			images: [{ type: "image", mimeType: "image/png", data: "follow-active-image" }],
		});
		release();
		await promptPromise;

		expect(prompts).toEqual(["initial prompt", "follow active"]);
	});

	it("applies tool call and tool result hooks", async () => {
		const registration = registerProvider();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "hello" }, { id: "call-1" }), { stopReason: "toolUse" }),
		]);
		const schema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
				};
			},
		};
		const events: AgentHarnessEvent[] = [];
		const harness = createHarness({ model: registration.getModel(), tools: [tool] });
		harness.subscribe((event) => {
			events.push(event);
		});
		harness.on("tool_call", (event) => {
			expect(event).toMatchObject({ toolCallId: "call-1", toolName: "echo", input: { value: "hello" } });
			return undefined;
		});
		harness.on("tool_result", (event) => {
			expect(event).toMatchObject({ toolCallId: "call-1", toolName: "echo", isError: false });
			return {
				content: [{ type: "text", text: "patched" }],
				details: { patched: true },
				isError: true,
				terminate: true,
			};
		});

		const response = await harness.prompt("use tool");

		expect(response.stopReason).toBe("toolUse");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "message_end",
				message: expect.objectContaining({
					role: "toolResult",
					content: [{ type: "text", text: "patched" }],
					details: { patched: true },
					isError: true,
				}),
			}),
		);

		const blockingProvider = registerProvider();
		blockingProvider.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "hello" }, { id: "call-2" }), { stopReason: "toolUse" }),
		]);
		const blockingHarness = createHarness({ model: blockingProvider.getModel(), tools: [tool] });
		blockingHarness.on("tool_call", () => ({ block: true, reason: "blocked" }));
		const blockedEvents: AgentHarnessEvent[] = [];
		blockingHarness.subscribe((event) => {
			blockedEvents.push(event);
		});
		await blockingHarness.prompt("use tool");
		expect(blockedEvents).toContainEqual(
			expect.objectContaining({
				type: "message_end",
				message: expect.objectContaining({
					role: "toolResult",
					content: [{ type: "text", text: "blocked" }],
					isError: true,
				}),
			}),
		);
	});

	it("uses compaction hooks for provided results and cancellation", async () => {
		const registration = registerProvider();
		const session = createSession();
		await session.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("assistant"));
		const events: AgentHarnessEvent[] = [];
		const harness = createHarness({
			model: registration.getModel(),
			session,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key", headers: { auth: "1" } }),
		});
		harness.subscribe((event) => {
			events.push(event);
		});
		harness.on("session_before_compact", (event) => {
			expect(event.customInstructions).toBe("focus");
			expect(event.branchEntries).toHaveLength(2);
			return {
				compaction: {
					summary: "hook summary",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { from: "hook" },
				},
			};
		});

		const result = await harness.compact("focus");

		expect(result.summary).toBe("hook summary");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "session_compact",
				fromHook: true,
				compactionEntry: expect.objectContaining({ summary: "hook summary" }),
			}),
		);
		await expect(harness.compact()).rejects.toThrow("Nothing to compact");

		const cancelSession = createSession();
		await cancelSession.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		const cancellingHarness = createHarness({
			model: registration.getModel(),
			session: cancelSession,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		cancellingHarness.on("session_before_compact", () => ({ cancel: true }));
		await expect(cancellingHarness.compact()).rejects.toThrow("Compaction cancelled");
		await cancellingHarness.prompt("after cancel");
	});

	it("reports compaction and tree navigation prerequisites", async () => {
		const registration = registerProvider();
		const noModelHarness = createHarness({
			model: undefined as unknown as Model<any>,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		await expect(noModelHarness.compact()).rejects.toThrow("No model set for compaction");

		const noAuthHarness = createHarness({ model: registration.getModel() });
		await expect(noAuthHarness.compact()).rejects.toThrow("No auth available for compaction");

		const missingTargetHarness = createHarness({ model: registration.getModel() });
		await expect(missingTargetHarness.navigateTree("missing")).rejects.toThrow("Entry missing not found");

		const noBranchModelSession = createSession();
		const noBranchModelTargetId = await noBranchModelSession.appendMessage({
			role: "user",
			content: "target",
			timestamp: Date.now(),
		});
		await noBranchModelSession.appendMessage(fauxAssistantMessage("current"));
		const noBranchModelHarness = createHarness({
			model: undefined as unknown as Model<any>,
			session: noBranchModelSession,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		await expect(noBranchModelHarness.navigateTree(noBranchModelTargetId, { summarize: true })).rejects.toThrow(
			"No model set for branch summary",
		);

		const noBranchAuthSession = createSession();
		const noBranchAuthTargetId = await noBranchAuthSession.appendMessage({
			role: "user",
			content: "target",
			timestamp: Date.now(),
		});
		await noBranchAuthSession.appendMessage(fauxAssistantMessage("current"));
		const noBranchAuthHarness = createHarness({ model: registration.getModel(), session: noBranchAuthSession });
		await expect(noBranchAuthHarness.navigateTree(noBranchAuthTargetId, { summarize: true })).rejects.toThrow(
			"No auth available for branch summary",
		);
	});

	it("runs provider-backed compaction when hooks do not provide a result", async () => {
		const registration = registerProvider();
		registration.setResponses([fauxAssistantMessage("provider summary")]);
		const session = createSession();
		await session.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("assistant"));
		const events: AgentHarnessEvent[] = [];
		const harness = createHarness({
			model: registration.getModel(),
			session,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		harness.subscribe((event) => {
			events.push(event);
		});

		const result = await harness.compact("focus");

		expect(result.summary).toContain("provider summary");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "session_compact",
				fromHook: false,
			}),
		);
	});

	it("navigates the session tree with hook-provided summaries and editor text", async () => {
		const registration = registerProvider();
		registration.setResponses([fauxAssistantMessage("after cancel")]);
		const session = createSession();
		const firstUserId = await session.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		const assistantId = await session.appendMessage(fauxAssistantMessage("assistant"));
		const secondUserId = await session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: Date.now(),
		});
		await session.appendMessage(fauxAssistantMessage("latest"));

		const events: AgentHarnessEvent[] = [];
		const harness = createHarness({
			model: registration.getModel(),
			session,
		});
		harness.subscribe((event) => {
			events.push(event);
		});
		harness.on("session_before_tree", (event) => {
			expect(event.preparation.targetId).toBe(secondUserId);
			return { summary: { summary: "tree summary", details: { from: "hook" } } };
		});

		const result = await harness.navigateTree(secondUserId, { summarize: true, label: "return" });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("second");
		expect(result.summaryEntry).toMatchObject({ type: "branch_summary", summary: "tree summary", fromHook: true });
		expect(await session.getLeafId()).not.toBe(firstUserId);
		expect(await session.getLeafId()).not.toBe(assistantId);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "session_tree",
				summaryEntry: expect.objectContaining({ summary: "tree summary" }),
				fromHook: true,
			}),
		);

		const sameLeafResult = await harness.navigateTree((await session.getLeafId()) ?? "");
		expect(sameLeafResult).toEqual({ cancelled: false });

		const cancelSession = createSession();
		const cancelTargetId = await cancelSession.appendMessage({
			role: "user",
			content: "target",
			timestamp: Date.now(),
		});
		await cancelSession.appendMessage(fauxAssistantMessage("current"));
		const cancellingHarness = createHarness({ model: registration.getModel(), session: cancelSession });
		cancellingHarness.on("session_before_tree", () => ({ cancel: true }));
		expect(await cancellingHarness.navigateTree(cancelTargetId)).toEqual({ cancelled: true });
	});

	it("drains steer and follow-up queues and reports abort results", async () => {
		const registration = registerProvider();
		registration.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);
		const events: AgentHarnessEvent[] = [];
		const harness = createHarness({
			model: registration.getModel(),
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
		});
		harness.subscribe((event) => {
			events.push(event);
			if (event.type === "agent_start") {
				harness.steer("steer before loop", {
					images: [{ type: "image", mimeType: "image/png", data: "steer-image" }],
				});
			}
			if (
				event.type === "message_start" &&
				event.message.role === "assistant" &&
				assistantText(event.message) === "first"
			) {
				harness.steer("steer while active", {
					images: [{ type: "image", mimeType: "image/png", data: "steer-active-image" }],
				});
				harness.followUp("follow while active", {
					images: [{ type: "image", mimeType: "image/png", data: "follow-image" }],
				});
			}
		});

		await harness.prompt("start");
		const abortResult = await harness.abort();
		await harness.waitForIdle();

		expect(abortResult).toEqual({ clearedSteer: [], clearedFollowUp: [] });
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "queue_update",
				steer: [],
				followUp: [],
			}),
		);
		expect(events).toContainEqual({ type: "abort", clearedSteer: [], clearedFollowUp: [] });
	});

	it("generates branch summaries while navigating and supports custom-message targets", async () => {
		const registration = registerProvider();
		registration.setResponses([fauxAssistantMessage("generated branch summary")]);
		const session = createSession();
		const rootUserId = await session.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("shared"));
		await session.appendMessage({ role: "user", content: "new branch", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("latest"));
		const harness = createHarness({
			model: registration.getModel(),
			session,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});

		const result = await harness.navigateTree(rootUserId, {
			summarize: true,
			customInstructions: "focus",
			replaceInstructions: true,
		});

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("root");
		expect(result.summaryEntry).toMatchObject({
			type: "branch_summary",
			fromHook: false,
		});

		const customSession = createSession();
		const customId = await customSession.appendCustomMessageEntry("note", "custom target", true);
		await customSession.appendMessage(fauxAssistantMessage("after custom"));
		const customHarness = createHarness({ model: registration.getModel(), session: customSession });
		customHarness.on("session_before_tree", () => ({ summary: { summary: "custom summary" } }));

		const customResult = await customHarness.navigateTree(customId, { summarize: true });

		expect(customResult.cancelled).toBe(false);
		expect(customResult.editorText).toBe("custom target");
		expect(customResult.summaryEntry).toMatchObject({ summary: "custom summary" });

		const customArraySession = createSession();
		const customArrayId = await customArraySession.appendCustomMessageEntry(
			"note",
			[
				{ type: "text", text: "array " },
				{ type: "image", mimeType: "image/png", data: "abc" },
				{ type: "text", text: "target" },
			],
			true,
		);
		await customArraySession.appendMessage(fauxAssistantMessage("after custom array"));
		const customArrayHarness = createHarness({ model: registration.getModel(), session: customArraySession });
		customArrayHarness.on("session_before_tree", () => ({ summary: { summary: "custom array summary" } }));
		const customArrayResult = await customArrayHarness.navigateTree(customArrayId, { summarize: true });
		expect(customArrayResult.editorText).toBe("array target");

		const assistantTargetSession = createSession();
		await assistantTargetSession.appendMessage({ role: "user", content: "user", timestamp: Date.now() });
		const assistantId = await assistantTargetSession.appendMessage(fauxAssistantMessage("assistant target"));
		await assistantTargetSession.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
		const assistantTargetHarness = createHarness({ model: registration.getModel(), session: assistantTargetSession });
		const assistantTargetResult = await assistantTargetHarness.navigateTree(assistantId);
		expect(assistantTargetResult).toEqual({ cancelled: false, editorText: undefined, summaryEntry: undefined });
		expect(await assistantTargetSession.getLeafId()).toBe(assistantId);
	});

	it("uses tree hook generation overrides and default generated summary file lists", async () => {
		const registration = registerProvider();
		let prompt = "";
		registration.setResponses([
			(context) => {
				const user = context.messages[0];
				const content = user?.role === "user" && Array.isArray(user.content) ? user.content[0] : undefined;
				prompt = content?.type === "text" ? content.text : "";
				return fauxAssistantMessage("hook-generated summary");
			},
		]);
		const session = createSession();
		const targetId = await session.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("current"));
		const harness = createHarness({
			model: registration.getModel(),
			session,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		harness.on("session_before_tree", () => ({
			customInstructions: "HOOK ONLY",
			replaceInstructions: true,
		}));

		const result = await harness.navigateTree(targetId, {
			summarize: true,
			customInstructions: "option focus",
			replaceInstructions: false,
		});

		expect(prompt).toContain("HOOK ONLY");
		expect(prompt).not.toContain("option focus");
		expect(result.summaryEntry).toMatchObject({
			type: "branch_summary",
			details: { readFiles: [], modifiedFiles: [] },
		});
	});

	it("uses empty detail lists when branch summarization has no message content", async () => {
		const registration = registerProvider();
		const session = createSession();
		const targetId = await session.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await session.appendMessage({
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "tool only" }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		});
		const harness = createHarness({
			model: registration.getModel(),
			session,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});

		const result = await harness.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry).toMatchObject({
			type: "branch_summary",
			summary: "No content to summarize",
			details: { readFiles: [], modifiedFiles: [] },
		});
	});

	it("propagates generated branch summary errors", async () => {
		const registration = registerProvider();
		registration.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad branch" })]);
		const session = createSession();
		const targetId = await session.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("current"));
		const harness = createHarness({
			model: registration.getModel(),
			session,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});

		await expect(harness.navigateTree(targetId, { summarize: true })).rejects.toThrow("bad branch");
	});

	it("cancels navigation when generated branch summaries abort", async () => {
		const registration = registerProvider();
		registration.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);
		const session = createSession();
		const targetId = await session.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await session.appendMessage(fauxAssistantMessage("current"));
		const harness = createHarness({
			model: registration.getModel(),
			session,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});

		expect(await harness.navigateTree(targetId, { summarize: true })).toEqual({ cancelled: true });
	});
});
