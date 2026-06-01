import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.js";
import type { ContextUsage } from "./extensions/index.js";
import type { SessionManager } from "./session-manager.js";

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

export function getAgentSessionStats(options: {
	messages: AgentMessage[];
	sessionFile: string | undefined;
	sessionId: string;
	contextUsage?: ContextUsage;
}): SessionStats {
	const { messages, sessionFile, sessionId, contextUsage } = options;

	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const message of messages) {
		switch (message.role) {
			case "user":
				userMessages++;
				break;
			case "assistant":
				assistantMessages++;
				for (const content of message.content) {
					if (content.type === "toolCall") toolCalls++;
				}
				totalInput += message.usage.input;
				totalOutput += message.usage.output;
				totalCacheRead += message.usage.cacheRead;
				totalCacheWrite += message.usage.cacheWrite;
				totalCost += message.usage.cost.total;
				break;
			case "toolResult":
				toolResults++;
				break;
		}
	}

	return {
		sessionFile,
		sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: messages.length,
		tokens: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
		},
		cost: totalCost,
		contextUsage,
	};
}

export function getAgentSessionContextUsage(options: {
	contextWindow: number | undefined;
	messages: AgentMessage[];
	sessionManager: SessionManager;
}): ContextUsage | undefined {
	const { contextWindow, messages, sessionManager } = options;
	if (!contextWindow || contextWindow <= 0) {
		return undefined;
	}

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// Usage is only trustworthy once an assistant responded after the latest compaction.
	const branchEntries = sessionManager.getBranch();
	let compactionIndex = -1;
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		if (branchEntries[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}

	if (compactionIndex !== -1) {
		let hasPostCompactionUsage = false;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const assistant = entry.message;
			if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
			hasPostCompactionUsage = calculateContextTokens(assistant.usage) > 0;
			break;
		}

		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const estimate = estimateContextTokens(messages);

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent: (estimate.tokens / contextWindow) * 100,
	};
}
