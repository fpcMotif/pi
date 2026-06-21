/**
 * Provider wiring (ADR-0003 / ADR-0020 decision 5): building and resolving
 * the layers performs no network IO — `LanguageModel` resolves against a
 * stubbed HttpClient (open seam) and against the baked fetch client.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";

import { openAiLanguageModelLayer, openAiLanguageModelLayerHttp } from "../../../effect/providers/openai.js";
import { stubHttpClient } from "../../../test-support/stub-http-client.js";

describe("providers/openai", () => {
	it.effect("openAiLanguageModelLayerHttp resolves a LanguageModel over a stub HttpClient", () =>
		Effect.gen(function* () {
			const lm = yield* LanguageModel.LanguageModel;
			assert.isDefined(lm.streamText);
		}).pipe(
			Effect.provide(
				openAiLanguageModelLayerHttp({ model: "gpt-4o-mini", apiKey: "test-key", apiUrl: "http://localhost:1" }).pipe(
					Layer.provide(stubHttpClient({ status: 200, body: "{}" })),
				),
			),
		),
	);

	it.effect("openAiLanguageModelLayer bakes in the fetch HttpClient", () =>
		Effect.gen(function* () {
			const lm = yield* LanguageModel.LanguageModel;
			assert.isDefined(lm.generateText);
		}).pipe(Effect.provide(openAiLanguageModelLayer({ model: "gpt-4o-mini", apiKey: "test-key" }))),
	);
});
