import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import type { LlmPart, ToolCompleted, ToolDispatched } from "../../effect/agent-event.js";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

describe("Session.send lifts tool-call / tool-result parts into ToolDispatched / ToolCompleted", () => {
	it.effect(
		"emits ToolDispatched after LlmPart for a tool-call part, and ToolCompleted after LlmPart for a tool-result part",
		() =>
			Effect.gen(function* () {
				const session = yield* Session.empty;
				const events = yield* Stream.runCollect(session.send("What's the weather in Paris?"));

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

				const dispatched = events[2] as ToolDispatched;
				expect(dispatched.toolName).toBe("GetWeather");
				expect(dispatched.toolCallId).toBe("call_w1");
				expect(dispatched.params).toEqual({ city: "Paris" });

				const completed = events[4] as ToolCompleted;
				expect(completed.toolName).toBe("GetWeather");
				expect(completed.toolCallId).toBe("call_w1");
				expect(completed.isFailure).toBe(false);
				expect(completed.result).toEqual({ temperature: 72, condition: "sunny" });

				// LlmPart wrappers preserve the raw upstream part shape verbatim.
				const llm1 = events[1] as LlmPart;
				expect((llm1.part as { type: string }).type).toBe("tool-call");
				const llm3 = events[3] as LlmPart;
				expect((llm3.part as { type: string }).type).toBe("tool-result");
			}).pipe(
				Effect.provide(
					stubLanguageModelStream([
						{ type: "text-delta", id: "msg_1", delta: "Looking up weather... " },
						{
							type: "tool-call",
							id: "call_w1",
							name: "GetWeather",
							params: { city: "Paris" },
							providerExecuted: false,
						},
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
	);

	it.effect("a tool-result with isFailure: true round-trips that flag into ToolCompleted.isFailure", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("..."));

			const completed = events.find((e) => e._tag === "ToolCompleted") as ToolCompleted | undefined;
			expect(completed).toBeDefined();
			expect(completed?.isFailure).toBe(true);
			expect(completed?.result).toEqual({ _tag: "ServiceDown", reason: "timeout" });
		}).pipe(
			Effect.provide(
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
	);
});
