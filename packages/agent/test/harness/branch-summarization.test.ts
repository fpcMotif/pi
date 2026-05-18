import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "../../src/harness/compaction/branch-summarization.js";
import { computeFileLists } from "../../src/harness/compaction/utils.js";
import { Session } from "../../src/harness/session/session.js";
import { InMemorySessionStorage } from "../../src/harness/session/storage/memory.js";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomMessageEntry,
	MessageEntry,
	SessionTreeEntry,
} from "../../src/harness/types.js";
import type { AgentMessage } from "../../src/types.js";

let nextId = 0;
const registrations: FauxProviderRegistration[] = [];

beforeEach(() => {
	nextId = 0;
});

afterEach(() => {
	while (registrations.length > 0) {
		registrations.pop()?.unregister();
	}
});

function createId(): string {
	nextId++;
	return `entry-${nextId}`;
}

function createSession(): Session {
	return new Session(new InMemorySessionStorage({ metadata: { id: "session-1", createdAt: "now" } }));
}

function registerProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return registration;
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function messageEntry(message: AgentMessage, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function branchSummaryEntry(parentId: string | null, fromHook = false): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		fromId: parentId ?? "root",
		summary: "branch summary",
		details: { readFiles: ["src/read.ts"], modifiedFiles: ["src/edited.ts"] },
		fromHook,
	};
}

function compactionEntry(parentId: string | null): CompactionEntry {
	return {
		type: "compaction",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		summary: "compaction summary",
		firstKeptEntryId: parentId ?? "root",
		tokensBefore: 123,
	};
}

function customMessageEntry(parentId: string | null): CustomMessageEntry {
	return {
		type: "custom_message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		customType: "note",
		content: [
			{ type: "text", text: "custom " },
			{ type: "image", mimeType: "image/png", data: "abc" },
			{ type: "text", text: "message" },
		],
		display: true,
		details: { source: "test" },
	};
}

describe("branch summarization", () => {
	it("collects entries from the old branch back to the common ancestor", async () => {
		const session = createSession();
		const rootId = await session.appendMessage(userMessage("root"));
		const sharedId = await session.appendMessage(fauxAssistantMessage("shared"));
		await session.moveTo(rootId);
		const targetId = await session.appendMessage(userMessage("target"));
		await session.moveTo(sharedId);
		const oldUserId = await session.appendMessage(userMessage("old branch"));
		const oldLeafId = await session.appendMessage(fauxAssistantMessage("old answer"));

		const result = await collectEntriesForBranchSummary(session, oldLeafId, targetId);

		expect(result.commonAncestorId).toBe(rootId);
		expect(result.entries.map((entry) => entry.id)).toEqual([sharedId, oldUserId, oldLeafId]);
		expect(await collectEntriesForBranchSummary(session, null, targetId)).toEqual({
			entries: [],
			commonAncestorId: null,
		});

		const missingEntrySession = {
			async getBranch(id: string) {
				if (id === "old") return [{ id: "old", parentId: "missing" }] as SessionTreeEntry[];
				return [] as SessionTreeEntry[];
			},
			async getEntry() {
				return undefined;
			},
		} as unknown as Session;
		expect(await collectEntriesForBranchSummary(missingEntrySession, "old", "target")).toEqual({
			entries: [],
			commonAncestorId: null,
		});
	});

	it("prepares branch entries with file operation tracking and token budgeting", () => {
		const branchSummary = branchSummaryEntry(null);
		const hookSummary = branchSummaryEntry(branchSummary.id, true);
		const assistant = messageEntry(
			assistantMessage([
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/read.ts" } },
				{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "src/write.ts" } },
				{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/edited.ts" } },
			]),
			hookSummary.id,
		);
		const toolResult = messageEntry(
			{
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				details: {},
				isError: false,
				timestamp: Date.now(),
			},
			assistant.id,
		);
		const compaction = compactionEntry(toolResult.id);
		const custom = customMessageEntry(compaction.id);
		const ignored = {
			type: "session_info",
			id: createId(),
			parentId: custom.id,
			timestamp: new Date().toISOString(),
			name: "ignored",
		} satisfies SessionTreeEntry;
		const entries: SessionTreeEntry[] = [
			branchSummary,
			hookSummary,
			assistant,
			toolResult,
			compaction,
			custom,
			ignored,
		];

		const preparation = prepareBranchEntries(entries, 10000);
		const fileLists = computeFileLists(preparation.fileOps);

		expect(preparation.messages.map((message) => message.role)).toEqual([
			"branchSummary",
			"branchSummary",
			"assistant",
			"compactionSummary",
			"custom",
		]);
		expect(fileLists).toEqual({
			readFiles: ["src/read.ts"],
			modifiedFiles: ["src/edited.ts", "src/write.ts"],
		});

		const budgeted = prepareBranchEntries([branchSummary, hookSummary, assistant, toolResult, compaction], 1);
		expect(budgeted.messages.at(-1)?.role).toBe("compactionSummary");

		const budgetedSummary = prepareBranchEntries([branchSummaryEntry(null)], 1);
		expect(budgetedSummary.messages.map((message) => message.role)).toEqual(["branchSummary"]);

		const nonContentEntries: SessionTreeEntry[] = [
			{ type: "thinking_level_change", id: createId(), parentId: null, timestamp: "now", thinkingLevel: "high" },
			{ type: "model_change", id: createId(), parentId: null, timestamp: "now", provider: "openai", modelId: "gpt" },
			{ type: "custom", id: createId(), parentId: null, timestamp: "now", customType: "event" },
			{ type: "label", id: createId(), parentId: null, timestamp: "now", targetId: "entry", label: "checkpoint" },
			{ type: "session_info", id: createId(), parentId: null, timestamp: "now", name: "session" },
		];
		expect(prepareBranchEntries(nonContentEntries, 1000).messages).toEqual([]);
	});

	it("generates summaries with custom instructions and file lists", async () => {
		const registration = registerProvider();
		let prompt = "";
		let seenApiKey = "";
		registration.setResponses([
			(context, options) => {
				const user = context.messages[0];
				const content = user?.role === "user" && Array.isArray(user.content) ? user.content[0] : undefined;
				prompt = content?.type === "text" ? content.text : "";
				seenApiKey = options?.apiKey ?? "";
				return fauxAssistantMessage("## Goal\nSummarized");
			},
		]);
		const assistant = messageEntry(
			assistantMessage([
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/read.ts" } },
				{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "src/write.ts" } },
			]),
		);

		const result = await generateBranchSummary([messageEntry(userMessage("summarize")), assistant], {
			model: registration.getModel(),
			apiKey: "test-key",
			headers: { auth: "1" },
			signal: new AbortController().signal,
			customInstructions: "focus on files",
		});

		expect(seenApiKey).toBe("test-key");
		expect(prompt).toContain("Additional focus: focus on files");
		expect(result.summary).toContain("Summary of that exploration");
		expect(result.summary).toContain("<read-files>\nsrc/read.ts\n</read-files>");
		expect(result.summary).toContain("<modified-files>\nsrc/write.ts\n</modified-files>");
		expect(result.readFiles).toEqual(["src/read.ts"]);
		expect(result.modifiedFiles).toEqual(["src/write.ts"]);

		const fallbackWindowProvider = registerProvider();
		fallbackWindowProvider.setResponses([fauxAssistantMessage("## Goal\nFallback window")]);
		const fallbackWindow = await generateBranchSummary([messageEntry(userMessage("fallback window"))], {
			model: { ...fallbackWindowProvider.getModel(), contextWindow: 0 },
			apiKey: "test-key",
			signal: new AbortController().signal,
		});
		expect(fallbackWindow.summary).toContain("Fallback window");
	});

	it("supports replacement instructions and empty summaries", async () => {
		const registration = registerProvider();
		let prompt = "";
		registration.setResponses([
			(context) => {
				const user = context.messages[0];
				const content = user?.role === "user" && Array.isArray(user.content) ? user.content[0] : undefined;
				prompt = content?.type === "text" ? content.text : "";
				return fauxAssistantMessage("");
			},
		]);

		const empty = await generateBranchSummary([], {
			model: registration.getModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});
		expect(empty).toEqual({ summary: "No content to summarize" });

		const result = await generateBranchSummary([messageEntry(userMessage("replace"))], {
			model: registration.getModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
			customInstructions: "ONLY THIS",
			replaceInstructions: true,
		});

		expect(prompt).toContain("ONLY THIS");
		expect(prompt).not.toContain("Additional focus");
		expect(result.summary).toContain("Summary of that exploration");
	});

	it("reports aborted and errored summarization responses", async () => {
		const abortedProvider = registerProvider();
		abortedProvider.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);
		const aborted = await generateBranchSummary([messageEntry(userMessage("abort"))], {
			model: abortedProvider.getModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});
		expect(aborted).toEqual({ aborted: true });

		const errorProvider = registerProvider();
		errorProvider.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "bad summary" })]);
		const errored = await generateBranchSummary([messageEntry(userMessage("error"))], {
			model: errorProvider.getModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});
		expect(errored).toEqual({ error: "bad summary" });

		const fallbackErrorProvider = registerProvider();
		fallbackErrorProvider.setResponses([fauxAssistantMessage("", { stopReason: "error" })]);
		const fallbackErrored = await generateBranchSummary([messageEntry(userMessage("error"))], {
			model: fallbackErrorProvider.getModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});
		expect(fallbackErrored).toEqual({ error: "Summarization failed" });
	});
});
