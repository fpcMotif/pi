import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	type AgentError,
	CancellationError,
	LlmError,
	SchemaError,
	StoreError,
	ToolError,
} from "../../effect/agent-error.js";

describe("AgentError tagged classes", () => {
	it("each variant constructs with the correct _tag and fields", () => {
		const llm = new LlmError({ aiError: { reason: { _tag: "RateLimitError" } } });
		expect(llm._tag).toBe("LlmError");

		const tool = new ToolError({
			toolName: "GetWeather",
			toolCallId: "call_1",
			cause: new Error("boom"),
		});
		expect(tool._tag).toBe("ToolError");
		expect(tool.toolName).toBe("GetWeather");

		const schema = new SchemaError({ description: "invalid input shape" });
		expect(schema._tag).toBe("SchemaError");
		expect(schema.description).toBe("invalid input shape");

		const store = new StoreError({ store: "SessionStore", operation: "load", message: "failed", cause: null });
		expect(store._tag).toBe("StoreError");
		expect(store.store).toBe("SessionStore");

		const cancellation = new CancellationError({});
		expect(cancellation._tag).toBe("CancellationError");
	});

	it("each variant is yieldable in an Effect.gen and propagates through the error channel", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const expectedErrors: ReadonlyArray<AgentError> = [
					new LlmError({ aiError: null }),
					new ToolError({ toolName: "T", toolCallId: "c", cause: null }),
					new SchemaError({ description: "bad" }),
					new StoreError({ store: "SessionStore", operation: "save", message: "bad", cause: null }),
					new CancellationError({}),
				];

				for (const expected of expectedErrors) {
					const actual = yield* Effect.flip(Effect.fail(expected));
					expect(actual._tag).toBe(expected._tag);
				}
			}),
		));
});
