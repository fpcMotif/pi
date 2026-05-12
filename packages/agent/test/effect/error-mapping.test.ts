import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

describe("HTTP error mapping (AiError.RateLimitError)", () => {
	it.effect("propagates an AiError.RateLimitError from createResponse through generateText", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "anything" }));

			expect(AiError.isAiError(error)).toBe(true);
			expect(error.reason._tag).toBe("RateLimitError");
			expect(error.reason.isRetryable).toBe(true);
			// the retryAfter Duration we set in the stub round-trips intact
			expect(error.reason._tag === "RateLimitError" && error.reason.retryAfter !== undefined).toBe(true);
		}).pipe(
			Effect.provide(
				OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
					Layer.provide(
						stubOpenAiClient({
							error: AiError.make({
								module: "OpenAi",
								method: "createResponse",
								reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(30) }),
							}),
						}),
					),
				),
			),
		),
	);
});
