import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Cause, Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { Session } from "../../effect/session.js";
import { stubLanguageModelStreamScripted } from "../../test-support/stub-language-model-stream-scripted.js";
import { stubOpenAiClientScripted } from "../../test-support/stub-openai-client-scripted.js";

const rateLimit = AiError.make({
	module: "scripted-stub-test",
	method: "createResponse",
	reason: new AiError.RateLimitError({}),
});

const expectDefectMessage = (cause: Cause.Cause<unknown>, expected: string): void => {
	const defect = Cause.squash(cause);
	expect(String(defect)).toContain(expected);
};

describe("scripted test stubs", () => {
	it.effect("stubOpenAiClientScripted propagates scripted error steps through generateText", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "anything" })).pipe(
				Effect.provide(
					OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
						Layer.provide(stubOpenAiClientScripted([{ type: "error", error: rateLimit }])),
					),
				),
			);

			expect(error).toBe(rateLimit);
		}),
	);

	it.effect("stubOpenAiClientScripted dies loudly when the script is over-consumed", () =>
		Effect.gen(function* () {
			const exit = yield* LanguageModel.generateText({ prompt: "anything" }).pipe(
				Effect.provide(
					OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(Layer.provide(stubOpenAiClientScripted([]))),
				),
				Effect.exit,
			);

			expect(exit._tag).toBe("Failure");
			if (exit._tag === "Failure") {
				expectDefectMessage(exit.cause, "stubOpenAiClientScripted: no scripted response for call 0");
			}
		}),
	);

	it.effect("stubLanguageModelStreamScripted dies loudly when the script is over-consumed", () =>
		Effect.gen(function* () {
			const session = yield* Session.make({ maxLlmRetries: 0 });
			const exit = yield* Stream.runDrain(session.send("hello")).pipe(
				Effect.provide(stubLanguageModelStreamScripted([])),
				Effect.exit,
			);

			expect(exit._tag).toBe("Failure");
			if (exit._tag === "Failure") {
				expectDefectMessage(exit.cause, "stubLanguageModelStreamScripted: no scripted response for call 0");
			}
		}),
	);
});
