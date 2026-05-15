import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

/** Minimal `HttpRequestDetails` shape for `NetworkError` constructor calls. */
const stubRequest = {
	method: "POST" as const,
	url: "https://api.example.com/v1/chat",
	urlParams: [] as ReadonlyArray<readonly [string, string]>,
	hash: undefined,
	headers: {} as Record<string, string>,
};

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
	// NetworkError carries a sub-reason; isRetryable is true iff the sub-reason is "TransportError".
	{
		label: "NetworkError (TransportError)",
		reason: new AiError.NetworkError({ reason: "TransportError", request: stubRequest }),
		expectedTag: "NetworkError" as const,
		expectedRetryable: true,
	},
	{
		label: "NetworkError (EncodeError)",
		reason: new AiError.NetworkError({ reason: "EncodeError", request: stubRequest }),
		expectedTag: "NetworkError" as const,
		expectedRetryable: false,
	},
	{
		label: "NetworkError (InvalidUrlError)",
		reason: new AiError.NetworkError({ reason: "InvalidUrlError", request: stubRequest }),
		expectedTag: "NetworkError" as const,
		expectedRetryable: false,
	},
	{
		label: "InternalProviderError",
		reason: new AiError.InternalProviderError({ description: "upstream 502" }),
		expectedTag: "InternalProviderError" as const,
		expectedRetryable: true,
	},
	{
		label: "InvalidOutputError",
		reason: new AiError.InvalidOutputError({ description: "model returned non-JSON" }),
		expectedTag: "InvalidOutputError" as const,
		expectedRetryable: true,
	},
	{
		label: "StructuredOutputError",
		reason: new AiError.StructuredOutputError({
			description: "JSON did not satisfy schema",
			responseText: '{"oops":',
		}),
		expectedTag: "StructuredOutputError" as const,
		expectedRetryable: true,
	},
	{
		label: "UnsupportedSchemaError",
		reason: new AiError.UnsupportedSchemaError({ description: "recursive schema rejected" }),
		expectedTag: "UnsupportedSchemaError" as const,
		expectedRetryable: false,
	},
	{
		label: "UnknownError",
		reason: new AiError.UnknownError({ description: "unclassified provider error" }),
		expectedTag: "UnknownError" as const,
		expectedRetryable: false,
	},
	{
		label: "InvalidUserInputError",
		reason: new AiError.InvalidUserInputError({ description: "prompt exceeded model max tokens" }),
		expectedTag: "InvalidUserInputError" as const,
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
