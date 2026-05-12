import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

const GetWeather = Tool.make("GetWeather", {
	description: "Get the current weather for a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
});

const Weather = Toolkit.make(GetWeather);

const WeatherHandlers = Weather.toLayer({
	GetWeather: ({ city: _city }) => Effect.succeed({ temperature: 72, condition: "sunny" }),
});

describe("Tool calling (Tool.make + Toolkit + function_call output)", () => {
	it.effect("invokes the handler and surfaces its return value in toolResults", () =>
		Effect.gen(function* () {
			const response = yield* LanguageModel.generateText({
				prompt: "What's the weather in Paris?",
				toolkit: Weather,
			});

			expect(response.toolResults).toHaveLength(1);
			expect(response.toolResults[0].name).toBe("GetWeather");
			expect(response.toolResults[0].result).toEqual({ temperature: 72, condition: "sunny" });
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					WeatherHandlers,
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
