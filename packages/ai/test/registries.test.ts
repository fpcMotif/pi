import { afterEach, describe, expect, it } from "vitest";
import {
	clearApiProviders,
	getApiProvider,
	getApiProviders,
	registerApiProvider,
	unregisterApiProviders,
} from "../src/api-registry.js";
import { getImagesApiProvider, registerImagesApiProvider } from "../src/images-api-registry.js";
import { resetApiProviders } from "../src/providers/register-builtins.js";
import { cleanupSessionResources, registerSessionResourceCleanup } from "../src/session-resources.js";
import { complete, completeSimple, stream, streamSimple } from "../src/stream.js";
import type { AssistantImages, AssistantMessage, Context, ImagesContext, ImagesModel, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function doneMessage(model: { api: string; provider: string; id: string }): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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

function fakeModel(api: string): Model<string> {
	return {
		id: "reg-model",
		name: "Reg Model",
		api,
		provider: "reg-provider",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

// resetApiProviders() restores the built-in OpenAI-family providers. Tests in
// this file mutate the shared registry, so reset afterwards.
afterEach(() => {
	resetApiProviders();
});

describe("api-registry", () => {
	it("wraps stream/streamSimple and dispatches to the matching api", async () => {
		const sourceId = "registries-test-source";
		const api = "registries-fake-api";
		const model = fakeModel(api);

		registerApiProvider(
			{
				api,
				stream: (m) => {
					const s = new AssistantMessageEventStream();
					s.push({ type: "done", reason: "stop", message: doneMessage(m) });
					s.end();
					return s;
				},
				streamSimple: (m) => {
					const s = new AssistantMessageEventStream();
					s.push({ type: "done", reason: "stop", message: doneMessage(m) });
					s.end();
					return s;
				},
			},
			sourceId,
		);

		const provider = getApiProvider(api);
		expect(provider).toBeDefined();
		expect(getApiProviders().some((p) => p.api === api)).toBe(true);

		const completed = await complete(model, context);
		expect(completed.stopReason).toBe("stop");
		const completedSimple = await completeSimple(model, context);
		expect(completedSimple.stopReason).toBe("stop");

		unregisterApiProviders(sourceId);
		expect(getApiProvider(api)).toBeUndefined();
	});

	it("throws on a model whose api does not match the registered provider (stream)", async () => {
		const api = "registries-mismatch-api";
		registerApiProvider(
			{
				api,
				stream: (m) => {
					const s = new AssistantMessageEventStream();
					s.push({ type: "done", reason: "stop", message: doneMessage(m) });
					s.end();
					return s;
				},
				streamSimple: (m) => {
					const s = new AssistantMessageEventStream();
					s.push({ type: "done", reason: "stop", message: doneMessage(m) });
					s.end();
					return s;
				},
			},
			"registries-mismatch-source",
		);

		const provider = getApiProvider(api)!;
		const wrongModel = fakeModel("some-other-api");
		expect(() => provider.stream(wrongModel, context)).toThrow("Mismatched api: some-other-api expected " + api);
		expect(() => provider.streamSimple(wrongModel, context)).toThrow(
			"Mismatched api: some-other-api expected " + api,
		);

		unregisterApiProviders("registries-mismatch-source");
	});

	it("clearApiProviders empties the registry", () => {
		clearApiProviders();
		expect(getApiProviders()).toEqual([]);
		expect(getApiProvider("openai-completions")).toBeUndefined();
	});

	it("resetApiProviders restores the built-in OpenAI-family providers", () => {
		clearApiProviders();
		resetApiProviders();
		expect(getApiProvider("openai-completions")).toBeDefined();
		expect(getApiProvider("openai-responses")).toBeDefined();
		expect(getApiProvider("openai-codex-responses")).toBeDefined();
	});
});

describe("images-api-registry", () => {
	it("wraps generateImages and dispatches to the matching api", async () => {
		const api = "registries-fake-images-api";
		const model: ImagesModel<string> = {
			id: "img-model",
			name: "Img Model",
			api,
			provider: "reg-provider",
			baseUrl: "http://localhost:0",
			input: ["text"],
			output: ["image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const result: AssistantImages = {
			api,
			provider: model.provider,
			model: model.id,
			output: [],
			stopReason: "stop",
			timestamp: Date.now(),
		};
		registerImagesApiProvider({ api, generateImages: async () => result }, "registries-images-source");

		const provider = getImagesApiProvider(api);
		expect(provider).toBeDefined();
		const imagesContext: ImagesContext = { input: [{ type: "text", text: "x" }] };
		await expect(provider!.generateImages(model, imagesContext)).resolves.toBe(result);

		const wrongModel = { ...model, api: "wrong-images-api" };
		expect(() => provider!.generateImages(wrongModel, imagesContext)).toThrow(
			"Mismatched api: wrong-images-api expected " + api,
		);
	});

	it("returns undefined for an unregistered images api", () => {
		expect(getImagesApiProvider("nonexistent-images-api")).toBeUndefined();
	});
});

describe("session-resources", () => {
	it("runs every registered cleanup with the session id and supports unregister", () => {
		const seen: Array<string | undefined> = [];
		const unregister = registerSessionResourceCleanup((sessionId) => seen.push(sessionId));

		cleanupSessionResources("session-abc");
		expect(seen).toEqual(["session-abc"]);

		unregister();
		cleanupSessionResources("session-def");
		expect(seen).toEqual(["session-abc"]);
	});

	it("collects errors from failing cleanups into an AggregateError", () => {
		const unregisterA = registerSessionResourceCleanup(() => {
			throw new Error("cleanup-a-failed");
		});
		const unregisterB = registerSessionResourceCleanup(() => {
			throw new Error("cleanup-b-failed");
		});

		try {
			expect(() => cleanupSessionResources()).toThrow(AggregateError);
			try {
				cleanupSessionResources();
			} catch (error) {
				const aggregate = error as AggregateError;
				expect(aggregate.errors).toHaveLength(2);
				expect(aggregate.message).toBe("Failed to cleanup session resources");
			}
		} finally {
			unregisterA();
			unregisterB();
		}
	});
});

describe("stream module dispatch", () => {
	it("stream/streamSimple throw when no provider is registered for the api", () => {
		clearApiProviders();
		const model = fakeModel("never-registered-api");
		expect(() => stream(model, context)).toThrow("No API provider registered for api: never-registered-api");
		expect(() => streamSimple(model, context)).toThrow("No API provider registered for api: never-registered-api");
	});
});
