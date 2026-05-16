/**
 * Tracer bullet for reasoning-block persistence in history (slice 27).
 *
 * Behavior:
 *
 * - `reasoning-start` / `reasoning-delta` / `reasoning-end` parts now flow
 *   through the accumulator the same way `text-start` / `text-delta` /
 *   `text-end` do, but into a separate `pendingReasoning` field. Flushing
 *   emits a `{ type: "reasoning", text }` part into the assistant message's
 *   `content` array.
 * - Cross-flush invariant: every delta flushes the OTHER accumulator first,
 *   so the arrival order of `text-delta` and `reasoning-delta` is preserved
 *   even when no explicit boundary part separates them. Tool-call /
 *   tool-result boundaries flush both accumulators.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

describe("Session.send persists reasoning blocks in history alongside text + tool parts", () => {
	it.effect("text → tool → reasoning → text flow produces [text, tool-call, tool-result, reasoning, text]", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("What's the weather in Paris?"));

			const snapshot = yield* SubscriptionRef.get(session.state);
			const assistant = snapshot.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};
			expect(assistant.content.map((p) => p.type)).toEqual([
				"text",
				"tool-call",
				"tool-result",
				"reasoning",
				"text",
			]);
			expect(assistant.content[0]?.text).toBe("Looking up... ");
			expect(assistant.content[3]?.text).toBe("The model returned 72°F sunny; that matches Paris in summer.");
			expect(assistant.content[4]?.text).toBe("It's 72 and sunny in Paris.");
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", delta: "Looking up... " },
					{ type: "text-end", id: "t1" },
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
					{ type: "reasoning-start", id: "r1" },
					{ type: "reasoning-delta", id: "r1", delta: "The model returned 72°F sunny; " },
					{ type: "reasoning-delta", id: "r1", delta: "that matches Paris in summer." },
					{ type: "reasoning-end", id: "r1" },
					{ type: "text-start", id: "t2" },
					{ type: "text-delta", id: "t2", delta: "It's 72 and sunny in Paris." },
					{ type: "text-end", id: "t2" },
				]),
			),
		),
	);

	it.effect("interleaved text-delta and reasoning-delta WITHOUT boundary markers still preserve arrival order", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("..."));

			const snapshot = yield* SubscriptionRef.get(session.state);
			const assistant = snapshot.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};

			// Without explicit start/end markers, the cross-flush in each delta
			// ensures alternating runs land as separate parts in order: text("a"),
			// reasoning("b"), text("c"). If cross-flush were missing, this would
			// produce something like [text("ac"), reasoning("b")] with broken order.
			expect(assistant.content.map((p) => p.type)).toEqual(["text", "reasoning", "text"]);
			expect(assistant.content.map((p) => p.text)).toEqual(["a", "b", "c"]);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{ type: "text-delta", id: "t1", delta: "a" },
					{ type: "reasoning-delta", id: "r1", delta: "b" },
					{ type: "text-delta", id: "t2", delta: "c" },
				]),
			),
		),
	);

	it.effect("consecutive reasoning-deltas in one block coalesce into ONE ReasoningPart", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("..."));

			const snapshot = yield* SubscriptionRef.get(session.state);
			const assistant = snapshot.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};

			expect(assistant.content).toHaveLength(1);
			expect(assistant.content[0]?.type).toBe("reasoning");
			expect(assistant.content[0]?.text).toBe("hmm thinking deeply");
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{ type: "reasoning-start", id: "r1" },
					{ type: "reasoning-delta", id: "r1", delta: "hmm " },
					{ type: "reasoning-delta", id: "r1", delta: "thinking " },
					{ type: "reasoning-delta", id: "r1", delta: "deeply" },
					{ type: "reasoning-end", id: "r1" },
				]),
			),
		),
	);
});
