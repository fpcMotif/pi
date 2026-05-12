import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { AiError, LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

const GetWeather = Tool.make("GetWeather", {
	description: "Get the current weather for a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
});

const Weather = Toolkit.make(GetWeather);

// Handler returns an obviously wrong shape. The cast bypasses TS's compile-time
// guard so we can exercise the runtime schema validation path.
const BadWeatherHandlers = Weather.toLayer({
	GetWeather: (() => Effect.succeed({ wrong: "shape", missing: "fields" })) as never,
});

describe("Schema error path (handler returns invalid success value)", () => {
	it.effect("wraps the schema encode failure into AiError.ToolResultEncodingError", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				LanguageModel.generateText({
					prompt: "What's the weather in Paris?",
					toolkit: Weather,
				}),
			);

			expect(AiError.isAiError(error)).toBe(true);
			expect(error.reason._tag).toBe("ToolResultEncodingError");
			expect(error.reason.isRetryable).toBe(false);
			if (error.reason._tag === "ToolResultEncodingError") {
				expect(error.reason.toolName).toBe("GetWeather");
				expect(error.reason.description).toMatch(/temperature|condition|number|string/i);
			}
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					BadWeatherHandlers,
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
