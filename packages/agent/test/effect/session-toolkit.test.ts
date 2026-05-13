/**
 * Tracer bullet for toolkit threading through `Session.send`.
 *
 * `session.send(prompt, toolkit)` forwards the toolkit to
 * `LanguageModel.streamText({ prompt, toolkit })`. The upstream OpenAi
 * provider — driven by the canned `function_call` SSE event sequence — emits
 * a `tool-call` part, the framework's outer wrapper invokes the toolkit's
 * `GetWeather` handler (from `WeatherHandlers` Layer), the framework emits a
 * `tool-result` part, and `Session.send`'s `liftPart` flatMap surfaces both
 * as `ToolDispatched` and `ToolCompleted` AgentEvents.
 *
 * This is the end-to-end provider + tool + events test:
 * stub-OpenAi-streaming → real OpenAiLanguageModel → framework tool dispatch
 * → real handler → Session.send lifting.
 */
import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import type { ToolCompleted, ToolDispatched } from "../../effect/agent-event.js";
import { Session } from "../../effect/session.js";
import { stubOpenAiClientStreaming } from "../../test-support/stub-openai-client-streaming.js";

const GetWeather = Tool.make("GetWeather", {
	description: "Get the current weather for a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
});

const Weather = Toolkit.make(GetWeather);

const WeatherHandlers = Weather.toLayer({
	GetWeather: ({ city: _city }) => Effect.succeed({ temperature: 72, condition: "sunny" }),
});

describe("Session.send threads a toolkit through to LanguageModel.streamText", () => {
	it.effect(
		"a function_call SSE sequence flows through the toolkit handler and surfaces as ToolDispatched + ToolCompleted",
		() =>
			Effect.gen(function* () {
				const session = yield* Session.empty;
				const events = yield* Stream.runCollect(session.send("What's the weather in Paris?", Weather));

				const tags = events.map((e) => e._tag);

				const dispatchedIdx = tags.indexOf("ToolDispatched");
				const completedIdx = tags.indexOf("ToolCompleted");
				const finishIdx = tags.indexOf("Finish");

				expect(dispatchedIdx).toBeGreaterThanOrEqual(0);
				expect(completedIdx).toBeGreaterThan(dispatchedIdx);
				expect(finishIdx).toBe(tags.length - 1);

				const dispatched = events[dispatchedIdx] as ToolDispatched;
				expect(dispatched.toolName).toBe("GetWeather");
				expect(dispatched.params).toEqual({ city: "Paris" });

				const completed = events[completedIdx] as ToolCompleted;
				expect(completed.toolName).toBe("GetWeather");
				expect(completed.isFailure).toBe(false);
				expect(completed.result).toEqual({ temperature: 72, condition: "sunny" });
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						WeatherHandlers,
						OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
							Layer.provide(
								stubOpenAiClientStreaming({
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
