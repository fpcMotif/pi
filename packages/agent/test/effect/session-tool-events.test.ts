import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import type { AgentEvent, LlmPart, ToolCompleted, ToolDispatched } from "../../effect/agent-event.js";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

const getToolDispatched = (events: ReadonlyArray<AgentEvent>, index: number): ToolDispatched => {
	const event = events[index];
	if (event?._tag !== "ToolDispatched") {
		throw new Error(`expected ToolDispatched at index ${index}`);
	}
	return event;
};

const getToolCompleted = (events: ReadonlyArray<AgentEvent>, index: number): ToolCompleted => {
	const event = events[index];
	if (event?._tag !== "ToolCompleted") {
		throw new Error(`expected ToolCompleted at index ${index}`);
	}
	return event;
};

const getLlmPart = (events: ReadonlyArray<AgentEvent>, index: number): LlmPart => {
	const event = events[index];
	if (event?._tag !== "LlmPart") {
		throw new Error(`expected LlmPart at index ${index}`);
	}
	return event;
};

const partType = (part: unknown): unknown =>
	typeof part === "object" && part !== null && "type" in part ? part.type : undefined;

const GetWeather = Tool.make("GetWeather", {
	description: "Get the current weather for a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
});

const Weather = Toolkit.make(GetWeather);

const WeatherHandlers = Weather.toLayer({
	GetWeather: ({ city: _city }) => Effect.succeed({ temperature: 72, condition: "sunny" }),
});

const ServiceDown = Schema.Struct({
	_tag: Schema.Literal("ServiceDown"),
	reason: Schema.String,
});

const FlakyTool = Tool.make("FlakyTool", {
	description: "A tool whose result is already present in the model stream.",
	parameters: Schema.Struct({}),
	success: Schema.Struct({ ok: Schema.Boolean }),
	failure: ServiceDown,
});

const FlakyToolkit = Toolkit.make(FlakyTool);

const FlakyHandlers = FlakyToolkit.toLayer({
	FlakyTool: () => Effect.succeed({ ok: true }),
});

describe("Session.send lifts tool-call / tool-result parts into ToolDispatched / ToolCompleted", () => {
	it.effect(
		"emits ToolDispatched after LlmPart for a tool-call part, and ToolCompleted after LlmPart for a tool-result part",
		() =>
			Effect.gen(function* () {
				const session = yield* Session.empty;
				const events = yield* Stream.runCollect(session.send("What's the weather in Paris?", Weather));

				// Expected sequence:
				//   [0] LlmPart (text-delta)
				//   [1] LlmPart (tool-call)        ← raw
				//   [2] ToolDispatched              ← lifted from tool-call
				//   [3] LlmPart (tool-result)      ← raw
				//   [4] ToolCompleted               ← lifted from tool-result
				//   [5] Finish
				expect(events).toHaveLength(6);
				expect(events.map((e) => e._tag)).toEqual([
					"LlmPart",
					"LlmPart",
					"ToolDispatched",
					"LlmPart",
					"ToolCompleted",
					"Finish",
				]);

				const dispatched = getToolDispatched(events, 2);
				expect(dispatched.toolName).toBe("GetWeather");
				expect(dispatched.toolCallId).toBe("call_w1");
				expect(dispatched.params).toEqual({ city: "Paris" });

				const completed = getToolCompleted(events, 4);
				expect(completed.toolName).toBe("GetWeather");
				expect(completed.toolCallId).toBe("call_w1");
				expect(completed.isFailure).toBe(false);
				expect(completed.result).toEqual({ temperature: 72, condition: "sunny" });

				// LlmPart wrappers preserve the raw upstream part shape verbatim.
				const llm1 = getLlmPart(events, 1);
				expect(partType(llm1.part)).toBe("tool-call");
				const llm3 = getLlmPart(events, 3);
				expect(partType(llm3.part)).toBe("tool-result");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						WeatherHandlers,
						stubLanguageModelStream([
							{ type: "text-delta", id: "msg_1", delta: "Looking up weather... " },
							{
								type: "tool-call",
								id: "call_w1",
								name: "GetWeather",
								params: { city: "Paris" },
								providerExecuted: false,
							},
							// The permissive `stubLanguageModelStream` does not run toolkit
							// dispatch, so the tool-result is scripted directly into the
							// stream — the same part shape `LanguageModel.streamText` would
							// synthesise from a `GetWeather` dispatch. `WeatherHandlers` and
							// the `Weather` toolkit arg stay wired so the test still
							// exercises the real `send(prompt, toolkit)` signature.
							{
								type: "tool-result",
								id: "call_w1",
								name: "GetWeather",
								isFailure: false,
								result: { temperature: 72, condition: "sunny" },
								providerExecuted: false,
							},
						]),
					),
				),
			),
	);

	it.effect("a tool-result with isFailure: true round-trips that flag into ToolCompleted.isFailure", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("...", FlakyToolkit));

			const completed = events.find((e): e is ToolCompleted => e._tag === "ToolCompleted");
			expect(completed).toBeDefined();
			expect(completed?.isFailure).toBe(true);
			expect(completed?.result).toEqual({ _tag: "ServiceDown", reason: "timeout" });
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					FlakyHandlers,
					stubLanguageModelStream([
						{
							type: "tool-result",
							id: "call_x",
							name: "FlakyTool",
							isFailure: true,
							result: { _tag: "ServiceDown", reason: "timeout" },
							providerExecuted: false,
						},
					]),
				),
			),
		),
	);
});
