// ADR-0017 phase C.7: test-sessions.ts is a pure fixture-data module — two
// `export const` session objects used by the example app. It declares no
// functions; the `=>` occurrences inside it are string literals (code
// snippets stored as test data). v8 reports it as 0% only because nothing
// imports it. Importing it executes the module and asserts the fixtures are
// well-formed.
import { describe, expect, it } from "vitest";

import { longSession, simpleHtml } from "../src/utils/test-sessions.js";

describe("test-sessions fixtures", () => {
	it("simpleHtml is a well-formed session fixture", () => {
		expect(simpleHtml.systemPrompt).toContain("helpful AI assistant");
		expect(simpleHtml.model.id).toBe("claude-3-5-haiku-20241022");
		expect(simpleHtml.model.provider).toBe("anthropic");
		expect(Array.isArray(simpleHtml.messages)).toBe(true);
		expect(simpleHtml.messages.length).toBeGreaterThan(0);
		// First message is a user turn with text content.
		expect(simpleHtml.messages[0].role).toBe("user");
	});

	it("simpleHtml contains an artifacts tool call", () => {
		const toolCalls = simpleHtml.messages
			.filter((m) => m.role === "assistant")
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((c: { type: string }) => c.type === "toolCall");
		expect(toolCalls.some((c: { name?: string }) => c.name === "artifacts")).toBe(true);
	});

	it("longSession is a well-formed session fixture with many messages", () => {
		expect(longSession.model).toBeDefined();
		expect(Array.isArray(longSession.messages)).toBe(true);
		// "long" session — substantially more messages than the simple one.
		expect(longSession.messages.length).toBeGreaterThan(simpleHtml.messages.length);
	});

	it("longSession messages all carry a recognized role", () => {
		const roles = new Set(longSession.messages.map((m) => m.role));
		for (const role of roles) {
			expect(["user", "assistant", "toolResult", "user-with-attachments", "artifact"]).toContain(role);
		}
	});
});
