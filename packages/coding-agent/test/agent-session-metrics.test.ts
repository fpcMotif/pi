import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getAgentSessionContextUsage } from "../src/core/agent-session-metrics.js";
import { SessionManager } from "../src/core/session-manager.js";

function userMsg(text: string, ts = 1): Message {
	return { role: "user", content: text, timestamp: ts };
}

function assistantMsg(text: string, opts?: { stopReason?: string; tokens?: number; ts?: number }): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: opts?.tokens ?? 1,
			output: opts?.tokens ?? 1,
			cacheRead: opts?.tokens ?? 0,
			cacheWrite: opts?.tokens ?? 0,
			totalTokens: (opts?.tokens ?? 1) * 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: (opts?.stopReason as "stop") ?? "stop",
		timestamp: opts?.ts ?? 2,
	};
}

describe("getAgentSessionContextUsage", () => {
	it("returns undefined when no model", () => {
		const sm = SessionManager.inMemory();
		expect(
			getAgentSessionContextUsage({
				model: undefined,
				messages: [],
				sessionManager: sm,
			}),
		).toBeUndefined();
	});

	it("returns undefined when contextWindow is 0", () => {
		const sm = SessionManager.inMemory();
		expect(
			getAgentSessionContextUsage({
				model: { contextWindow: 0 },
				messages: [],
				sessionManager: sm,
			}),
		).toBeUndefined();
	});

	it("returns undefined when contextWindow missing", () => {
		const sm = SessionManager.inMemory();
		expect(
			getAgentSessionContextUsage({
				model: {},
				messages: [],
				sessionManager: sm,
			}),
		).toBeUndefined();
	});

	it("returns estimate when no compaction", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(userMsg("hello"));
		sm.appendMessage(assistantMsg("response"));
		const usage = getAgentSessionContextUsage({
			model: { contextWindow: 1000 },
			messages: [userMsg("hello"), assistantMsg("response")],
			sessionManager: sm,
		});
		expect(usage).toBeDefined();
		expect(usage?.contextWindow).toBe(1000);
		expect(usage?.tokens).toBeGreaterThanOrEqual(0);
	});
});
