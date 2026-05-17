/**
 * Tracer bullet for per-text-block segmentation in history (slice 26).
 *
 * Behavior:
 *
 * - `text-start` and `text-end` parts act as flush boundaries on the
 *   assistant-content accumulator. Multiple text blocks separated by other
 *   parts (tool calls, reasoning, etc.) produce SEPARATE `TextPart`s in
 *   `state.history`'s assistant message — they no longer coalesce.
 * - Streams that emit `text-delta` WITHOUT bookending `text-start`/`text-end`
 *   markers still produce one combined `TextPart` via `finalize` —
 *   backward-compatible with every prior slice's tests.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

describe("Session.send segments assistant content by text-block boundaries", () => {
	it.effect("two bookended text blocks straddling a tool turn produce 4 distinct content parts", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("What's the weather in Paris?"));

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user", "assistant"]);

			// Assistant content must preserve the four distinct blocks in order:
			//   text("Looking up... ") → tool-call → tool-result → text("It's 72 and sunny.")
			// The OLD accumulator would have coalesced both texts into one part
			// at the same position. The text-start / text-end flushes make the
			// boundary explicit.
			const assistant = snapshot.history.content[1] as {
				readonly role: "assistant";
				readonly content: ReadonlyArray<{ readonly type: string }>;
			};
			expect(assistant.content.map((p) => p.type)).toEqual(["text", "tool-call", "tool-result", "text"]);

			const firstText = assistant.content[0] as unknown as { readonly text: string };
			const secondText = assistant.content[3] as unknown as { readonly text: string };
			expect(firstText.text).toBe("Looking up... ");
			expect(secondText.text).toBe("It's 72 and sunny.");
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{ type: "text-start", id: "block_a" },
					{ type: "text-delta", id: "block_a", delta: "Looking up... " },
					{ type: "text-end", id: "block_a" },
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
					{ type: "text-start", id: "block_b" },
					{ type: "text-delta", id: "block_b", delta: "It's 72 and sunny." },
					{ type: "text-end", id: "block_b" },
				]),
			),
		),
	);

	it.effect("two adjacent bookended blocks (no tool turn between) produce 2 distinct TextParts", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("..."));

			const snapshot = yield* SubscriptionRef.get(session.state);
			const assistant = snapshot.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};
			expect(assistant.content.map((p) => p.type)).toEqual(["text", "text"]);
			expect(assistant.content.map((p) => p.text)).toEqual(["Hello.", "Goodbye."]);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{ type: "text-start", id: "a" },
					{ type: "text-delta", id: "a", delta: "Hello." },
					{ type: "text-end", id: "a" },
					{ type: "text-start", id: "b" },
					{ type: "text-delta", id: "b", delta: "Goodbye." },
					{ type: "text-end", id: "b" },
				]),
			),
		),
	);

	it.effect("backward compat: text-delta without text-start/text-end still coalesces to one TextPart", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("hi"));

			const snapshot = yield* SubscriptionRef.get(session.state);
			const assistant = snapshot.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};
			expect(assistant.content.map((p) => p.type)).toEqual(["text"]);
			expect(assistant.content[0]?.text).toBe("hello world");
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{ type: "text-delta", id: "msg_1", delta: "hello " },
					{ type: "text-delta", id: "msg_1", delta: "world" },
				]),
			),
		),
	);
});
