import { describe, expect, it, vi } from "vitest";
import type { AssistantMessageEvent, Context, Model } from "../src/types.js";

// These tests exercise the lazy provider wrappers in
// src/providers/register-builtins.ts. The wrappers dynamically import the
// concrete provider module on first call; if that import throws, the wrapper
// must surface a terminal error event/message instead of rejecting.

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function codexModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function responsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

const context: Context = {
	systemPrompt: "You are helpful.",
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

describe("register-builtins lazy wrappers - successful module load", () => {
	it("loads the codex responses provider module and forwards its stream", async () => {
		const { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } = await import(
			"../src/providers/register-builtins.js"
		);

		// No API key -> the concrete provider emits a terminal error event, but
		// the lazy module load itself must succeed and forward the inner stream.
		const events = await collect(streamOpenAICodexResponses(codexModel(), context, {}));
		expect(events.at(-1)?.type).toBe("error");

		const simpleEvents = await collect(streamSimpleOpenAICodexResponses(codexModel(), context, { apiKey: "" }));
		// streamSimple throws synchronously inside the concrete module when no
		// key is present; the lazy wrapper turns that into a terminal error.
		expect(simpleEvents.at(-1)?.type).toBe("error");
	});

	it("loads the openai responses provider module and forwards its stream", async () => {
		const { streamOpenAIResponses, streamSimpleOpenAIResponses } = await import(
			"../src/providers/register-builtins.js"
		);

		const events = await collect(streamOpenAIResponses(responsesModel(), context, { apiKey: "" }));
		expect(events.at(-1)?.type).toBe("error");

		const simpleEvents = await collect(streamSimpleOpenAIResponses(responsesModel(), context, { apiKey: "" }));
		expect(simpleEvents.at(-1)?.type).toBe("error");
	});
});

describe("register-builtins lazy wrappers - module load failure", () => {
	it("surfaces a terminal error message when the codex provider module fails to import", async () => {
		vi.resetModules();
		vi.doMock("../src/providers/openai-codex-responses.js", () => {
			throw new Error("codex module import boom");
		});

		try {
			const { streamOpenAICodexResponses, streamSimpleOpenAICodexResponses } = await import(
				"../src/providers/register-builtins.js"
			);
			const model = codexModel();

			const events = await collect(streamOpenAICodexResponses(model, context, {}));
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("error");
			if (events[0].type === "error") {
				expect(events[0].error.stopReason).toBe("error");
				expect(events[0].error.errorMessage).toBeTruthy();
				expect(events[0].error.api).toBe(model.api);
				expect(events[0].error.provider).toBe(model.provider);
				expect(events[0].error.model).toBe(model.id);
				expect(events[0].error.content).toEqual([]);
			}

			const simpleStream = streamSimpleOpenAICodexResponses(model, context, {});
			const simpleEvents = await collect(simpleStream);
			expect(simpleEvents).toHaveLength(1);
			expect(simpleEvents[0].type).toBe("error");
			const finalMessage = await simpleStream.result();
			expect(finalMessage.stopReason).toBe("error");
			expect(finalMessage.errorMessage).toBeTruthy();
		} finally {
			vi.doUnmock("../src/providers/openai-codex-responses.js");
			vi.resetModules();
		}
	});

	it("surfaces a terminal error message when the completions provider module fails to import", async () => {
		vi.resetModules();
		vi.doMock("../src/providers/openai-completions.js", () => {
			throw new Error("completions module import boom");
		});

		try {
			const { streamOpenAICompletions, streamSimpleOpenAICompletions } = await import(
				"../src/providers/register-builtins.js"
			);
			const model: Model<"openai-completions"> = {
				id: "gpt-4o-mini",
				name: "GPT-4o mini",
				api: "openai-completions",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			};

			const events = await collect(streamOpenAICompletions(model, context, {}));
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("error");
			if (events[0].type === "error") {
				expect(events[0].error.stopReason).toBe("error");
				expect(events[0].error.errorMessage).toBeTruthy();
				expect(events[0].error.model).toBe(model.id);
			}

			const simpleEvents = await collect(streamSimpleOpenAICompletions(model, context, {}));
			expect(simpleEvents[0].type).toBe("error");
		} finally {
			vi.doUnmock("../src/providers/openai-completions.js");
			vi.resetModules();
		}
	});

	it("surfaces a terminal error message when the openai responses provider module fails to import", async () => {
		vi.resetModules();
		vi.doMock("../src/providers/openai-responses.js", () => {
			throw new Error("responses module import boom");
		});

		try {
			const { streamOpenAIResponses, streamSimpleOpenAIResponses } = await import(
				"../src/providers/register-builtins.js"
			);
			const model = responsesModel();

			const events = await collect(streamOpenAIResponses(model, context, {}));
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("error");
			if (events[0].type === "error") {
				expect(events[0].error.stopReason).toBe("error");
				expect(events[0].error.errorMessage).toBeTruthy();
				expect(events[0].error.model).toBe(model.id);
			}

			const simpleEvents = await collect(streamSimpleOpenAIResponses(model, context, {}));
			expect(simpleEvents[0].type).toBe("error");
		} finally {
			vi.doUnmock("../src/providers/openai-responses.js");
			vi.resetModules();
		}
	});
});
