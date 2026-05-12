import { it } from "@effect/vitest";
import { Effect } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubLanguageModel } from "../../test-support/stub-language-model.js";

describe("LanguageModel (stub Layer)", () => {
	it.effect("generateText resolves to the stubbed text", () =>
		Effect.gen(function* () {
			const response = yield* LanguageModel.generateText({ prompt: "anything" });
			expect(response.text).toBe("Hello, World!");
		}).pipe(Effect.provide(stubLanguageModel({ text: "Hello, World!" }))),
	);
});
