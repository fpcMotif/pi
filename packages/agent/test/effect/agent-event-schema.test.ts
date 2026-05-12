import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { AgentEvent, Finish, LlmPart, ToolCompleted, ToolDispatched } from "../../effect/agent-event.js";

describe("AgentEvent schema", () => {
	it("each variant constructs with the correct _tag", () => {
		const llm = new LlmPart({ part: { type: "text-delta", id: "msg_1", delta: "Hi" } });
		expect(llm._tag).toBe("LlmPart");

		const dispatched = new ToolDispatched({
			toolName: "GetWeather",
			toolCallId: "call_1",
			params: { city: "Paris" },
		});
		expect(dispatched._tag).toBe("ToolDispatched");

		const completed = new ToolCompleted({
			toolName: "GetWeather",
			toolCallId: "call_1",
			isFailure: false,
			result: { temperature: 72, condition: "sunny" },
		});
		expect(completed._tag).toBe("ToolCompleted");

		const finish = new Finish({ inputTokens: 10, outputTokens: 25 });
		expect(finish._tag).toBe("Finish");
	});

	it("AgentEvent union narrows by _tag in a Match-style switch", () => {
		const events: ReadonlyArray<AgentEvent> = [
			new LlmPart({ part: "anything" }),
			new ToolDispatched({ toolName: "T", toolCallId: "c", params: {} }),
			new ToolCompleted({ toolName: "T", toolCallId: "c", isFailure: false, result: 0 }),
			new Finish({}),
		];

		const tags = events.map((e) => e._tag);
		expect(tags).toEqual(["LlmPart", "ToolDispatched", "ToolCompleted", "Finish"]);
	});

	it("a LlmPart round-trips through Schema.decode / encode", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const original = new LlmPart({ part: { type: "text-delta", id: "msg_1", delta: "Hello" } });

				const encoded = yield* Schema.encodeEffect(AgentEvent)(original);
				const decoded = yield* Schema.decodeUnknownEffect(AgentEvent)(encoded);

				expect(decoded._tag).toBe("LlmPart");
				if (decoded._tag === "LlmPart") {
					expect(decoded.part).toEqual({ type: "text-delta", id: "msg_1", delta: "Hello" });
				}
			}),
		));

	it("Schema.decode on an unknown _tag fails", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const result = yield* Effect.flip(
					Schema.decodeUnknownEffect(AgentEvent)({ _tag: "NotARealVariant", anything: 1 }),
				);
				// decode failed — the flipped success is a SchemaError
				expect(result).toBeDefined();
			}),
		));
});
