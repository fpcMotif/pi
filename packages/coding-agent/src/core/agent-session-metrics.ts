import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.js";
import type { ContextUsage } from "./extensions/index.js";
import { getLatestCompactionEntry, type SessionManager } from "./session-manager.js";

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
	const userMessages = messages.filter((message) => message.role === "user").length;
	const assistantMessages = messages.filter((message) => message.role === "assistant").length;
	const toolResults = messages.filter((message) => message.role === "toolResult").length;

	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}

		toolCalls += message.content.filter((content) => content.type === "toolCall").length;
		totalInput += message.usage.input;
		totalOutput += message.usage.output;
		totalCacheRead += message.usage.cacheRead;
		totalCacheWrite += message.usage.cacheWrite;
		totalCost += message.usage.cost.total;
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
	model: { contextWindow?: number } | undefined;
	messages: AgentMessage[];
	sessionManager: SessionManager;
}): ContextUsage | undefined {
	const { model, messages, sessionManager } = options;
	if (!model) {
		return undefined;
	}

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) {
		return undefined;
	}

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// Usage is only trustworthy once an assistant responded after the latest compaction.
	const branchEntries = sessionManager.getBranch();
	const latestCompaction = getLatestCompactionEntry(branchEntries);

	if (latestCompaction) {
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		let hasPostCompactionUsage = false;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
					const contextTokens = calculateContextTokens(assistant.usage);
					if (contextTokens > 0) {
						hasPostCompactionUsage = true;
					}
					break;
				}
			}
		}

		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const estimate = estimateContextTokens(messages);
	const percent = (estimate.tokens / contextWindow) * 100;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent,
	};
}
