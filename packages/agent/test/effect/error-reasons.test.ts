import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

const cases = [
	{
		label: "RateLimitError",
		reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(30) }),
		expectedTag: "RateLimitError" as const,
		expectedRetryable: true,
	},
	{
		label: "AuthenticationError (InvalidKey)",
		reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
		expectedTag: "AuthenticationError" as const,
		expectedRetryable: false,
	},
	{
		label: "ContentPolicyError",
		reason: new AiError.ContentPolicyError({ description: "violates safety policy" }),
		expectedTag: "ContentPolicyError" as const,
		expectedRetryable: false,
	},
	{
		label: "QuotaExhaustedError",
		reason: new AiError.QuotaExhaustedError({}),
		expectedTag: "QuotaExhaustedError" as const,
		expectedRetryable: false,
	},
	{
		label: "InvalidRequestError",
		reason: new AiError.InvalidRequestError({
			parameter: "max_tokens",
			constraint: "must be > 0",
		}),
		expectedTag: "InvalidRequestError" as const,
		expectedRetryable: false,
	},
];

describe("AiError reason variants propagate through generateText", () => {
	it.effect.each(cases)(
		"$label round-trips with the right tag and isRetryable",
		({ reason, expectedTag, expectedRetryable }) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "anything" }));

				expect(AiError.isAiError(error)).toBe(true);
				expect(error.reason._tag).toBe(expectedTag);
				expect(error.reason.isRetryable).toBe(expectedRetryable);
			}).pipe(
				Effect.provide(
					OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
						Layer.provide(
							stubOpenAiClient({
								error: AiError.make({
									module: "OpenAi",
									method: "createResponse",
									reason,
								}),
							}),
						),
					),
				),
			),
	);
});
