/**
 * Tracer bullets for slice 31 — HTTP-status-driven error mapping.
 *
 * `stubHttpClient` resolves every request to a canned non-2xx `Response`.
 * Composed under the REAL `OpenAiClient.layer`, this drives the provider's
 * genuine HTTP-error path (`filterStatusOk` → `StatusCodeError` →
 * `@effect/ai-openai`'s `mapStatusCodeError` → `AiError`) — one layer deeper
 * than `stubOpenAiClient({ error })`, which hands back an `AiError` directly.
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { Session } from "../../effect/session.js";
import { stubHttpClient } from "../../test-support/stub-http-client.js";

const openAiLayer = (status: number, body?: string) =>
	OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
		Layer.provide(OpenAiClient.layer({})),
		Layer.provide(stubHttpClient({ status, body })),
	);

const cases = [
	{ status: 400, expectedTag: "InvalidRequestError" as const },
	{ status: 401, expectedTag: "AuthenticationError" as const },
	{ status: 403, expectedTag: "AuthenticationError" as const },
	{ status: 429, expectedTag: "RateLimitError" as const },
	{ status: 500, expectedTag: "InternalProviderError" as const },
];

describe("HTTP-driven error mapping", () => {
	it.effect("a 429 response maps to AiError.RateLimitError through generateText", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "anything" }));

			expect(AiError.isAiError(error)).toBe(true);
			expect(error.reason._tag).toBe("RateLimitError");
		}).pipe(Effect.provide(openAiLayer(429))),
	);

	it.effect.each(cases)("HTTP $status maps to AiError.$expectedTag through generateText", ({ status, expectedTag }) =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "anything" }));

			expect(AiError.isAiError(error)).toBe(true);
			expect(error.reason._tag).toBe(expectedTag);
		}).pipe(Effect.provide(openAiLayer(status))),
	);

	it.effect("a 429 HTTP error surfaces as LlmError through Session.send's stream error channel", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			// `Session.send` maps the upstream `AiError` to its pi-defined `LlmError`.
			// A 429 is retryable, so this also exercises the retry path before the
			// final error propagates.
			const error = yield* Effect.flip(Stream.runDrain(session.send("hello")));

			expect(error._tag).toBe("LlmError");
			expect(error._tag === "LlmError" && AiError.isAiError(error.aiError)).toBe(true);
			const aiError = (error as { readonly aiError: AiError.AiError }).aiError;
			expect(aiError.reason._tag).toBe("RateLimitError");
		}).pipe(Effect.provide(openAiLayer(429))),
	);
});
