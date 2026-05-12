import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { Chat, Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClientScripted } from "../../test-support/stub-openai-client-scripted.js";

const GetWeather = Tool.make("GetWeather", {
	description: "Get the current weather for a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
});

const Weather = Toolkit.make(GetWeather);

const WeatherHandlers = Weather.toLayer({
	GetWeather: ({ city: _city }) => Effect.succeed({ temperature: 72, condition: "sunny" }),
});

describe("Chat — turn 1 invokes a tool, turn 2 sees the result in history", () => {
	it.effect("tool-call turn followed by a follow-up turn produces a coherent history", () =>
		Effect.gen(function* () {
			const chat = yield* Chat.empty;

			// Turn 1: user asks a question that triggers the tool.
			const r1 = yield* chat.generateText({
				prompt: "What's the weather in Paris?",
				toolkit: Weather,
			});

			expect(r1.toolResults).toHaveLength(1);
			expect(r1.toolResults[0].name).toBe("GetWeather");
			expect(r1.toolResults[0].result).toEqual({ temperature: 72, condition: "sunny" });

			// Turn 2: user asks a follow-up — the stub returns a plain text answer.
			const r2 = yield* chat.generateText({
				prompt: "Based on that, what should I wear?",
			});

			expect(r2.text).toBe("A light jacket should be fine.");

			// History should preserve the original tool interaction AND the follow-up.
			const history = yield* Ref.get(chat.history);
			expect(history.content.length).toBeGreaterThanOrEqual(4);

			// At minimum, the first message should be the user's original question,
			// and the last should be the assistant's final answer.
			const firstRole = history.content[0]?.role;
			const lastRole = history.content[history.content.length - 1]?.role;
			expect(firstRole).toBe("user");
			expect(lastRole).toBe("assistant");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					WeatherHandlers,
					OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
						Layer.provide(
							stubOpenAiClientScripted([
								{
									type: "body",
									outputs: [
										{
											type: "function_call",
											name: "GetWeather",
											arguments: JSON.stringify({ city: "Paris" }),
										},
									],
								},
								{
									type: "body",
									outputs: [{ type: "text", text: "A light jacket should be fine." }],
								},
							]),
						),
					),
				),
			),
		),
	);
});
