import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

describe("OpenAiLanguageModel + stub OpenAiClient", () => {
	it.effect("generateText returns the stubbed completion text", () =>
		Effect.gen(function* () {
			const response = yield* LanguageModel.generateText({ prompt: "tell me a joke" });
			expect(response.text).toBe("Hello from the OpenAI stub!");
		}).pipe(
			Effect.provide(
				OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
					Layer.provide(stubOpenAiClient({ text: "Hello from the OpenAI stub!" })),
				),
			),
		),
	);
});
