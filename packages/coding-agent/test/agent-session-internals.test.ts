import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { exportSessionBranchToJsonl } from "../src/core/agent-session-jsonl.js";
import { extractUserMessageText, getLastAssistantText } from "../src/core/agent-session-messages.js";
import { getAgentSessionStats } from "../src/core/agent-session-metrics.js";
import { SessionManager } from "../src/core/session-manager.js";

const cleanupPaths: string[] = [];

afterEach(() => {
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop()!;
		if (existsSync(path)) {
			rmSync(path, { recursive: true, force: true });
		}
	}
});

function assistantMessage(text: string, options?: { aborted?: boolean; withToolCall?: boolean }): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(options?.withToolCall ? [{ type: "toolCall" as const, id: "tc-1", name: "read", arguments: {} }] : []),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
		stopReason: options?.aborted ? "aborted" : options?.withToolCall ? "toolUse" : "stop",
		timestamp: 2,
	};
}

describe("agent session internals", () => {
	it("extracts text from user content blocks", () => {
		expect(extractUserMessageText("plain")).toBe("plain");
		expect(
			extractUserMessageText([{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: " two" }]),
		).toBe("one two");
	});

	it("returns the last copyable assistant text", () => {
		const abortedAssistant: AssistantMessage = { ...assistantMessage("", { aborted: true }), content: [] };
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			assistantMessage("  first  "),
			abortedAssistant,
		];

		expect(getLastAssistantText(messages)).toBe("first");
	});

	it("summarizes session message counts, usage, and cost", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			assistantMessage("answer", { withToolCall: true }),
			{
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 3,
			},
		];

		expect(
			getAgentSessionStats({
				messages,
				sessionFile: "session.jsonl",
				sessionId: "session-id",
				contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
			}),
		).toEqual({
			sessionFile: "session.jsonl",
			sessionId: "session-id",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 3,
			tokens: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				total: 10,
			},
			cost: 1,
			contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
		});
	});

	it("exports the active branch as a linear JSONL session", () => {
		const tempDir = join(tmpdir(), `pi-session-internals-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cleanupPaths.push(tempDir);
		const sessionManager = SessionManager.create(tempDir);
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sessionManager.appendMessage(assistantMessage("answer"));

		const outputPath = exportSessionBranchToJsonl(
			sessionManager,
			join(tempDir, "export.jsonl"),
			new Date("2025-01-01T00:00:00.000Z"),
		);

		const lines = readFileSync(outputPath, "utf-8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({
			type: "session",
			id: sessionManager.getSessionId(),
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: tempDir,
		});
		expect(lines[1]).toMatchObject({ type: "message", parentId: null });
		expect(lines[2]).toMatchObject({ type: "message", parentId: lines[1].id });
	});
});
