import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type BashExecutionMessage,
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	type CustomMessage,
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	harnessTranscriptAdapters,
} from "../../src/harness/messages.js";
import type { AgentMessage } from "../../src/types.js";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "assistant" }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
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
	};
}

describe("harness messages", () => {
	it("formats bash execution messages for context", () => {
		const base: BashExecutionMessage = {
			role: "bashExecution",
			command: "bun run check",
			output: "failed",
			exitCode: 1,
			cancelled: false,
			truncated: true,
			fullOutputPath: "/tmp/full.log",
			timestamp: 1,
		};

		expect(bashExecutionToText(base)).toContain("Ran `bun run check`");
		expect(bashExecutionToText(base)).toContain("```");
		expect(bashExecutionToText(base)).toContain("Command exited with code 1");
		expect(bashExecutionToText(base)).toContain("[Output truncated. Full output: /tmp/full.log]");
		expect(bashExecutionToText({ ...base, output: "", exitCode: 0, truncated: false })).toContain("(no output)");
		expect(bashExecutionToText({ ...base, cancelled: true })).toContain("(command cancelled)");
	});

	it("creates timestamped summary and custom messages", () => {
		expect(createBranchSummaryMessage("branch", "from-id", "2026-01-01T00:00:00.000Z")).toEqual({
			role: "branchSummary",
			summary: "branch",
			fromId: "from-id",
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		});
		expect(createCompactionSummaryMessage("compact", 123, "2026-01-02T00:00:00.000Z")).toEqual({
			role: "compactionSummary",
			summary: "compact",
			tokensBefore: 123,
			timestamp: Date.parse("2026-01-02T00:00:00.000Z"),
		});
		expect(createCustomMessage("notice", "body", false, { ok: true }, "2026-01-03T00:00:00.000Z")).toEqual({
			role: "custom",
			customType: "notice",
			content: "body",
			display: false,
			details: { ok: true },
			timestamp: Date.parse("2026-01-03T00:00:00.000Z"),
		});
	});

	it("converts synthetic harness messages into LLM user messages", () => {
		const bash: BashExecutionMessage = {
			role: "bashExecution",
			command: "printf ok",
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		};
		const excludedBash: BashExecutionMessage = { ...bash, excludeFromContext: true };
		const customString: CustomMessage = {
			role: "custom",
			customType: "note",
			content: "custom text",
			display: true,
			timestamp: 2,
		};
		const customBlocks: CustomMessage = {
			role: "custom",
			customType: "blocks",
			content: [{ type: "text", text: "block text" }],
			display: true,
			timestamp: 3,
		};
		const branch = createBranchSummaryMessage("branch summary", "from", "2026-01-01T00:00:00.000Z");
		const compaction = createCompactionSummaryMessage("compact summary", 100, "2026-01-01T00:00:00.000Z");
		const unsupported = { role: "unsupported", timestamp: 4 } as unknown as AgentMessage;

		const converted = convertToLlm([bash, excludedBash, customString, customBlocks, branch, compaction, unsupported]);

		expect(converted).toHaveLength(5);
		expect(converted[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("ok") }],
		});
		expect(converted[1]).toEqual({ role: "user", content: [{ type: "text", text: "custom text" }], timestamp: 2 });
		expect(converted[2]).toEqual({ role: "user", content: [{ type: "text", text: "block text" }], timestamp: 3 });
		expect(converted[3]).toEqual({
			role: "user",
			content: [{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}branch summary${BRANCH_SUMMARY_SUFFIX}` }],
			timestamp: branch.timestamp,
		});
		expect(converted[4]).toEqual({
			role: "user",
			content: [{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}compact summary${COMPACTION_SUMMARY_SUFFIX}` }],
			timestamp: compaction.timestamp,
		});
	});

	it("passes native LLM message roles through unchanged", () => {
		const user: UserMessage = { role: "user", content: "hello", timestamp: 1 };
		const assistant = assistantMessage();
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 3,
		};

		expect(convertToLlm([user, assistant, toolResult])).toEqual([user, assistant, toolResult]);
	});

	it("each transcript adapter ignores messages whose role does not match its slot", () => {
		const bash: BashExecutionMessage = {
			role: "bashExecution",
			command: "printf ok",
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		};
		const custom = createCustomMessage("note", "body", true, undefined, "2026-01-01T00:00:00.000Z");
		const branch = createBranchSummaryMessage("branch", "from", "2026-01-01T00:00:00.000Z");
		const compaction = createCompactionSummaryMessage("compact", 1, "2026-01-01T00:00:00.000Z");

		expect(harnessTranscriptAdapters.bashExecution(compaction)).toEqual([]);
		expect(harnessTranscriptAdapters.custom(bash)).toEqual([]);
		expect(harnessTranscriptAdapters.branchSummary(custom)).toEqual([]);
		expect(harnessTranscriptAdapters.compactionSummary(branch)).toEqual([]);
	});
});
