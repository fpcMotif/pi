import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { AiError, LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

// A schema unrelated to the tool's success type. The handler will try to decode
// a bad value against it; decodeUnknownEffect fails with a Schema.SchemaError,
// which Toolkit's normalizeError wraps as InvalidToolResultError.
const InternalShape = Schema.Struct({ x: Schema.Number });

const GetWeather = Tool.make("GetWeather", {
	description: "Get the current weather for a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
});

const Weather = Toolkit.make(GetWeather);

const SchemaFailHandlers = Weather.toLayer({
	GetWeather: ((_params: unknown) => Schema.decodeUnknownEffect(InternalShape)({ x: "not a number" })) as never,
});

describe("Tool handler Effect.fail(SchemaError) (the InvalidToolResultError branch)", () => {
	it.effect("wraps a handler-side Schema.SchemaError as AiError.InvalidToolResultError", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				LanguageModel.generateText({
					prompt: "What's the weather in Paris?",
					toolkit: Weather,
				}),
			);

			expect(AiError.isAiError(error)).toBe(true);
			expect(error.reason._tag).toBe("InvalidToolResultError");
			expect(error.reason.isRetryable).toBe(false);
			if (error.reason._tag === "InvalidToolResultError") {
				expect(error.reason.toolName).toBe("GetWeather");
				expect(error.reason.description).toMatch(/Tool handler returned invalid result/);
			}
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					SchemaFailHandlers,
					OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
						Layer.provide(
							stubOpenAiClient({
								outputs: [
									{
										type: "function_call",
										name: "GetWeather",
										arguments: JSON.stringify({ city: "Paris" }),
									},
								],
							}),
						),
					),
				),
			),
		),
	);
});
