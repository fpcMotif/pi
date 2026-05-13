import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "../../src/harness/compaction/compaction.js";
import { createFileOps, extractFileOpsFromMessage } from "../../src/harness/compaction/utils.js";
import { buildSessionContext } from "../../src/harness/session/session.js";
import type {
	CompactionEntry,
	CompactionSettings,
	CustomMessageEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../../src/harness/types.js";
import type { AgentMessage } from "../../src/types.js";

let nextId = 0;
function createId(): string {
	return `entry-${nextId++}`;
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string, usage = createMockUsage(100, 50)): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMessageEntry(message: AgentMessage, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function createCompactionEntry(
	summary: string,
	firstKeptEntryId: string,
	parentId: string | null = null,
): CompactionEntry {
	return {
		type: "compaction",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 1234,
	};
}

function createCustomMessageEntry(content: string, parentId: string | null = null): CustomMessageEntry {
	return {
		type: "custom_message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		customType: "note",
		content,
		display: true,
	};
}

function createThinkingLevelEntry(level: string, parentId: string | null = null): ThinkingLevelChangeEntry {
	return {
		type: "thinking_level_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		thinkingLevel: level,
	};
}

function createModelChangeEntry(provider: string, modelId: string, parentId: string | null = null): ModelChangeEntry {
	return {
		type: "model_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
}

function createFauxModel(
	reasoning: boolean,
	maxTokens = 8192,
): { faux: FauxProviderRegistration; model: Model<string> } {
	const faux = registerFauxProvider({
		models: [
			{
				id: reasoning ? "reasoning-model" : "non-reasoning-model",
				reasoning,
				contextWindow: 200000,
				maxTokens,
			},
		],
	});
	fauxRegistrations.push(faux);
	return { faux, model: faux.getModel() };
}

const fauxRegistrations: FauxProviderRegistration[] = [];

afterEach(() => {
	while (fauxRegistrations.length > 0) {
		fauxRegistrations.pop()?.unregister();
	}
});

describe("harness compaction", () => {
	beforeEach(() => {
		nextId = 0;
	});

	it("calculates total context tokens from usage", () => {
		expect(calculateContextTokens(createMockUsage(1000, 500, 200, 100))).toBe(1800);
		expect(calculateContextTokens({ ...createMockUsage(10, 5, 2, 1), totalTokens: 0 })).toBe(18);
	});

	it("checks compaction threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};
		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
		expect(shouldCompact(95000, 100000, { ...settings, enabled: false })).toBe(false);
	});

	it("finds a cut point based on token differences", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let i = 0; i < 10; i++) {
			const user = createMessageEntry(createUserMessage(`User ${i}`), parentId);
			entries.push(user);
			const assistant = createMessageEntry(
				createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0)),
				user.id,
			);
			entries.push(assistant);
			parentId = assistant.id;
		}

		const result = findCutPoint(entries, 0, entries.length, 2500);
		expect(entries[result.firstKeptEntryIndex]?.type).toBe("message");
	});

	it("estimates tokens for custom message variants and finds turn starts", () => {
		const userString = { role: "user", content: "abcd", timestamp: Date.now() } as AgentMessage;
		const assistantRich = {
			...createAssistantMessage("", createMockUsage(0, 0)),
			content: [
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", id: "tool", name: "read", arguments: { path: "src/file.ts" } },
			],
		} satisfies AssistantMessage;
		const customString = { role: "custom", content: "abcdefgh", timestamp: Date.now() } as unknown as AgentMessage;
		const customBlocks = {
			role: "custom",
			content: [
				{ type: "text", text: "abcd" },
				{ type: "image", mediaType: "image/png", data: "abc" },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const bashExecution = {
			role: "bashExecution",
			command: "echo hi",
			output: "done",
			exitCode: 0,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const branchSummary = {
			role: "branchSummary",
			summary: "summary",
			fromId: "root",
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		expect(estimateTokens(userString)).toBe(1);
		expect(estimateTokens(assistantRich as AgentMessage)).toBeGreaterThan(0);
		expect(estimateTokens(customString)).toBe(2);
		expect(estimateTokens(customBlocks)).toBeGreaterThan(1000);
		expect(estimateTokens(bashExecution)).toBe(3);
		expect(estimateTokens(branchSummary)).toBe(2);
		expect(estimateTokens({ role: "unknown", timestamp: Date.now() } as unknown as AgentMessage)).toBe(0);

		const branchEntry = {
			type: "branch_summary",
			id: createId(),
			parentId: null,
			timestamp: new Date().toISOString(),
			fromId: "root",
			summary: "summary",
		} satisfies SessionTreeEntry;
		const customEntry = createCustomMessageEntry("custom", branchEntry.id);
		const bashEntry = createMessageEntry(bashExecution, customEntry.id);
		expect(findTurnStartIndex([branchEntry, customEntry, bashEntry], 2, 0)).toBe(2);
		expect(findTurnStartIndex([branchEntry, customEntry], 1, 0)).toBe(1);
		expect(findTurnStartIndex([createModelChangeEntry("openai", "gpt")], 0, 0)).toBe(-1);
		expect(findCutPoint([createModelChangeEntry("openai", "gpt")], 0, 1, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});
		const toolResultEntry = createMessageEntry({
			role: "toolResult",
			toolCallId: "tool",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now(),
		});
		expect(findCutPoint([toolResultEntry], 0, 1, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});
		expect(findCutPoint([createMessageEntry(bashExecution)], 0, 1, 1).firstKeptEntryIndex).toBe(0);
		const customMessage = createMessageEntry(customString);
		const branchSummaryMessage = createMessageEntry(branchSummary);
		const compactionSummaryMessage = createMessageEntry({
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 123,
			timestamp: Date.now(),
		} as unknown as AgentMessage);
		expect(
			findCutPoint([customMessage, branchSummaryMessage, compactionSummaryMessage], 0, 3, 1).firstKeptEntryIndex,
		).toBe(2);
		const ignoredNonMessageEntries: SessionTreeEntry[] = [
			createThinkingLevelEntry("medium"),
			createModelChangeEntry("openai", "gpt"),
			createCompactionEntry("summary", "kept"),
			{ type: "custom", id: createId(), parentId: null, timestamp: "now", customType: "event" },
			{ type: "label", id: createId(), parentId: null, timestamp: "now", targetId: "entry", label: "x" },
			{ type: "session_info", id: createId(), parentId: null, timestamp: "now", name: "session" },
		];
		expect(findCutPoint(ignoredNonMessageEntries, 0, ignoredNonMessageEntries.length, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});
		expect(findCutPoint([branchEntry, createCustomMessageEntry("custom")], 0, 2, 1).firstKeptEntryIndex).toBe(0);
		const leadingChange = createModelChangeEntry("openai", "gpt");
		const leadingUser = createMessageEntry(createUserMessage("large enough"), leadingChange.id);
		expect(findCutPoint([leadingChange, leadingUser], 0, 2, 1).firstKeptEntryIndex).toBe(0);
		const compactionBoundary = createCompactionEntry("boundary", "kept");
		const boundaryUser = createMessageEntry(createUserMessage("large enough"), compactionBoundary.id);
		expect(findCutPoint([compactionBoundary, boundaryUser], 0, 2, 1).firstKeptEntryIndex).toBe(1);
	});

	it("finds the last usable assistant usage", () => {
		const good = createMessageEntry(createAssistantMessage("good", createMockUsage(5, 2)));
		const aborted = createMessageEntry({ ...createAssistantMessage("aborted"), stopReason: "aborted" }, good.id);
		const errored = createMessageEntry({ ...createAssistantMessage("errored"), stopReason: "error" }, aborted.id);

		expect(getLastAssistantUsage([good, aborted, errored])).toEqual(createMockUsage(5, 2));
		expect(getLastAssistantUsage([createMessageEntry(createUserMessage("no usage"))])).toBeUndefined();
	});

	it("adds estimated trailing tokens after the last assistant usage", () => {
		const assistant = createAssistantMessage("tracked", createMockUsage(10, 5));
		const trailing = createUserMessage("x".repeat(16));

		expect(estimateContextTokens([assistant, trailing]).trailingTokens).toBe(4);
	});

	it("builds session context with a compaction entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"), u1.id);
		const u2 = createMessageEntry(createUserMessage("2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("b"), u2.id);
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id, a2.id);
		const u3 = createMessageEntry(createUserMessage("3"), compaction.id);
		const a3 = createMessageEntry(createAssistantMessage("c"), u3.id);
		const loaded = buildSessionContext([u1, a1, u2, a2, compaction, u3, a3]);
		expect(loaded.messages).toHaveLength(5);
		expect(loaded.messages[0]?.role).toBe("compactionSummary");
	});

	it("tracks model and thinking level changes in built context", () => {
		const user = createMessageEntry(createUserMessage("1"));
		const modelChange = createModelChangeEntry("openai", "gpt-4", user.id);
		const assistant = createMessageEntry(createAssistantMessage("a"), modelChange.id);
		const thinkingChange = createThinkingLevelEntry("high", assistant.id);
		const loaded = buildSessionContext([user, modelChange, assistant, thinkingChange]);
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});

	it("prepares compaction using the latest compaction summary as previousSummary", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"), u1.id);
		const u2 = createMessageEntry(createUserMessage("user msg 2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2", createMockUsage(5000, 1000)), u2.id);
		const compaction1 = createCompactionEntry("First summary", u2.id, a2.id);
		const u3 = createMessageEntry(createUserMessage("user msg 3"), compaction1.id);
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(8000, 2000)), u3.id);
		const pathEntries = [u1, a1, u2, a2, compaction1, u3, a3];
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();
		expect(preparation?.previousSummary).toBe("First summary");
		expect(preparation?.firstKeptEntryId).toBeTruthy();
		expect(preparation?.tokensBefore).toBe(estimateContextTokens(buildSessionContext(pathEntries).messages).tokens);
	});

	it("returns no preparation for empty branches or existing compaction leaves", () => {
		expect(prepareCompaction([], DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
		const compaction = createCompactionEntry("done", "kept");
		expect(prepareCompaction([compaction], DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});

	it("prepares split-turn compaction with previous file operation details", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const assistantWithTool = createMessageEntry(
			{
				...createAssistantMessage("tool call", createMockUsage(100, 10)),
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/current.ts" } }],
			},
			u1.id,
		);
		const compaction1 = {
			...createCompactionEntry("Previous summary", u1.id, assistantWithTool.id),
			details: { readFiles: ["src/old-read.ts"], modifiedFiles: ["src/old-edit.ts"] },
		};
		const custom = createCustomMessageEntry("custom note", compaction1.id);
		const branchSummary = {
			type: "branch_summary",
			id: createId(),
			parentId: custom.id,
			timestamp: new Date().toISOString(),
			fromId: custom.id,
			summary: "branch",
		} satisfies SessionTreeEntry;
		const userLong = createMessageEntry(createUserMessage("start split turn"), branchSummary.id);
		const assistantLong = createMessageEntry(createAssistantMessage("x".repeat(100)), userLong.id);

		const preparation = prepareCompaction(
			[u1, assistantWithTool, compaction1, custom, branchSummary, userLong, assistantLong],
			{ enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		);

		expect(preparation).toMatchObject({
			previousSummary: "Previous summary",
			isSplitTurn: true,
			firstKeptEntryId: assistantLong.id,
		});
		expect(preparation?.messagesToSummarize.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"custom",
			"branchSummary",
		]);
		expect(preparation?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
		expect(preparation?.fileOps.read).toEqual(new Set(["src/old-read.ts", "src/current.ts"]));
		expect(preparation?.fileOps.edited).toEqual(new Set(["src/old-edit.ts"]));
	});

	it("serializes conversation with truncated tool results", () => {
		const longContent = "x".repeat(5000);
		const messages = convertMessages([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "text", text: "visible answer" },
				],
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: "short result" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		]);
		const result = serializeConversation(messages);
		expect(result).toContain("[Assistant thinking]: hidden reasoning");
		expect(result).toContain("[Assistant]: visible answer");
		expect(result).toContain("[Tool result]: short result");
		expect(result).toContain("[... 3000 more characters truncated]");
	});

	it("ignores malformed file-operation tool call blocks", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(createUserMessage("not assistant"), fileOps);
		extractFileOpsFromMessage({ role: "assistant", content: "not blocks" } as unknown as AgentMessage, fileOps);
		extractFileOpsFromMessage(
			{
				...createAssistantMessage("", createMockUsage(0, 0)),
				content: [
					null,
					{ type: "text", text: "plain" },
					{ type: "toolCall", name: "read" },
					{ type: "toolCall", name: "read", arguments: undefined },
					{ type: "toolCall", name: "read", arguments: {} },
					{ type: "toolCall", name: "read", arguments: { path: 5 } },
				],
			} as unknown as AgentMessage,
			fileOps,
		);

		expect(fileOps).toEqual(createFileOps());
	});

	it("passes reasoning through generateSummary only for reasoning models with thinking enabled", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux: fauxReasoning, model: reasoningModel } = createFauxModel(true);
		fauxReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		await generateSummary(
			messages,
			reasoningModel,
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);
		expect(seenOptions[0]).toMatchObject({ reasoning: "medium", apiKey: "test-key" });

		const { faux: fauxOff, model: offModel } = createFauxModel(true);
		fauxOff.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		await generateSummary(messages, offModel, 2000, "test-key", undefined, undefined, undefined, undefined, "off");
		expect(seenOptions[1]).not.toHaveProperty("reasoning");

		const { faux: fauxNonReasoning, model: nonReasoningModel } = createFauxModel(false);
		fauxNonReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		await generateSummary(
			messages,
			nonReasoningModel,
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);
		expect(seenOptions[2]).not.toHaveProperty("reasoning");
	});

	it("adds custom instructions and previous summaries to generateSummary prompts", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		let prompt = "";
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const user = context.messages[0];
				const content = user?.role === "user" && Array.isArray(user.content) ? user.content[0] : undefined;
				prompt = content?.type === "text" ? content.text : "";
				return fauxAssistantMessage("## Goal\nUpdated");
			},
		]);

		const summary = await generateSummary(
			messages,
			model,
			2000,
			"test-key",
			undefined,
			undefined,
			"focus on decisions",
			"Previous summary",
		);

		expect(summary).toBe("## Goal\nUpdated");
		expect(prompt).toContain("<previous-summary>\nPrevious summary\n</previous-summary>");
		expect(prompt).toContain("Additional focus: focus on decisions");
	});

	it("throws when summary generation returns an error response", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad summary" })]);

		await expect(generateSummary(messages, model, 2000, "test-key")).rejects.toThrow(
			"Summarization failed: bad summary",
		);

		const { faux: fallbackFaux, model: fallbackModel } = createFauxModel(false);
		fallbackFaux.setResponses([fauxAssistantMessage("", { stopReason: "error" })]);
		await expect(generateSummary(messages, fallbackModel, 2000, "test-key")).rejects.toThrow(
			"Summarization failed: Unknown error",
		);
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(false, 128000);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(preparation, model, "test-key");

		expect(seenOptions.map((options) => options?.maxTokens)).toEqual([128000, 128000]);
	});

	it("uses reserve-token fallback when summary models have no output cap", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(false, 0);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);

		await generateSummary(messages, model, 2000, "test-key");

		expect(seenOptions[0]?.maxTokens).toBe(1600);
	});

	it("returns a compaction result with file details", async () => {
		const u1 = createMessageEntry(createUserMessage("read a file"));
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("calling tool", createMockUsage(1000, 200)),
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/index.ts" } }],
		};
		const a1 = createMessageEntry(assistantMessage, u1.id);
		const u2 = createMessageEntry(createUserMessage("continue"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("done", createMockUsage(4000, 500)), u2.id);
		const preparation = prepareCompaction([u1, a1, u2, a2], DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("## Goal\nTest summary")]);
		const result = await compact(preparation!, model, "test-key");
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(result.details).toBeDefined();
	});

	it("starts after a previous compaction when its first kept entry is missing", () => {
		const userBefore = createMessageEntry(createUserMessage("before"));
		const missingBoundary = createCompactionEntry("Previous summary", "missing-entry", userBefore.id);
		const userAfter = createMessageEntry(createUserMessage("after"), missingBoundary.id);
		const assistantAfter = createMessageEntry(
			createAssistantMessage("done", createMockUsage(4000, 500)),
			userAfter.id,
		);

		const preparation = prepareCompaction([userBefore, missingBoundary, userAfter, assistantAfter], {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 1,
		});

		expect(preparation).toMatchObject({
			previousSummary: "Previous summary",
			firstKeptEntryId: assistantAfter.id,
		});
		expect(preparation?.messagesToSummarize).toEqual([]);
	});

	it("keeps branch summaries in the history portion when compaction splits after them", () => {
		const branchSummary = {
			type: "branch_summary",
			id: createId(),
			parentId: null,
			timestamp: new Date().toISOString(),
			fromId: "root",
			summary: "branch context",
		} satisfies SessionTreeEntry;
		const user = createMessageEntry(createUserMessage("large request"), branchSummary.id);
		const assistant = createMessageEntry(
			createAssistantMessage("large response", createMockUsage(4000, 500)),
			user.id,
		);

		const preparation = prepareCompaction([branchSummary, user, assistant], {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 1,
		});

		expect(preparation?.messagesToSummarize.map((message) => message.role)).toEqual(["branchSummary"]);
	});

	it("skips non-message session metadata while building compaction history", () => {
		const modelChange = createModelChangeEntry("openai", "gpt");
		const user = createMessageEntry(createUserMessage("before"), modelChange.id);
		const assistant = createMessageEntry(createAssistantMessage("after", createMockUsage(4000, 500)), modelChange.id);

		const preparation = prepareCompaction([modelChange, user, assistant], {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 1,
		});

		expect(preparation?.messagesToSummarize).toEqual([]);
	});

	it("compacts split turns with no prior history and reasoning turn-prefix summaries", async () => {
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(true, 512);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("turn prefix");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: [createUserMessage("split turn request")],
			isSplitTurn: true,
			tokensBefore: 2000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 },
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, undefined, "medium");

		expect(result.summary).toContain("No prior history.");
		expect(result.summary).toContain("turn prefix");
		expect(seenOptions[0]).toMatchObject({ maxTokens: 512, reasoning: "medium" });
	});

	it("uses reserve-token fallback for turn-prefix summaries without a model output cap", async () => {
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(false, 0);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("turn prefix");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: [createUserMessage("split turn request")],
			isSplitTurn: true,
			tokensBefore: 2000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 },
		};

		const result = await compact(preparation, model, "test-key");

		expect(result.summary).toContain("turn prefix");
		expect(seenOptions[0]?.maxTokens).toBe(1000);
	});

	it("throws when turn-prefix summary generation returns an error response", async () => {
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad prefix" })]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: [createUserMessage("split turn request")],
			isSplitTurn: true,
			tokensBefore: 2000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 },
		};

		await expect(compact(preparation, model, "test-key")).rejects.toThrow(
			"Turn prefix summarization failed: bad prefix",
		);

		const { faux: fallbackFaux, model: fallbackModel } = createFauxModel(false);
		fallbackFaux.setResponses([fauxAssistantMessage("", { stopReason: "error" })]);
		await expect(compact(preparation, fallbackModel, "test-key")).rejects.toThrow(
			"Turn prefix summarization failed: Unknown error",
		);
	});

	it("rejects compaction results without a first kept entry id", async () => {
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("summary")]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "",
			messagesToSummarize: [createUserMessage("history")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 },
		};

		await expect(compact(preparation, model, "test-key")).rejects.toThrow(
			"First kept entry has no UUID - session may need migration",
		);
	});
});

function convertMessages(messages: any[]): any[] {
	return messages;
}
