// ADR-0017 phase C.4: covers the three defensive `typeof part !== "object"
// || part === null` guards in `effect/session.ts` (`liftPart`,
// `absorbPart`, `captureUsage`). Well-formed upstream `Response.StreamPart`
// streams never produce non-object parts, but the stubbed
// `stubLanguageModelStream` accepts `ReadonlyArray<unknown>`, so we drive
// the defensive branches directly here.
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";
import type { Finish } from "../../effect/agent-event.js";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

describe("Session.send tolerates malformed (non-object / null) stream parts", () => {
	it.effect(
		"null and primitive parts emit only LlmPart, skip the assistant accumulator, and don't capture usage",
		() =>
			Effect.gen(function* () {
				const session = yield* Session.empty;
				const events = yield* Stream.runCollect(session.send("ping"));

				const tags = events.map((e) => e._tag);
				// Each upstream part → exactly one LlmPart event (none of them are
				// tool-call / tool-result, so no lifted events).
				// Final Finish appended once by the trailing Stream.concat.
				expect(tags.filter((t) => t === "LlmPart").length).toBe(4);
				expect(tags.filter((t) => t === "ToolDispatched").length).toBe(0);
				expect(tags.filter((t) => t === "ToolCompleted").length).toBe(0);
				expect(tags.filter((t) => t === "Finish").length).toBe(1);

				const finish = events.find((e) => e._tag === "Finish") as Finish;
				// captureUsage returned null for every upstream part → state usage
				// stayed at 0 and Finish carried no tokens.
				expect(finish.inputTokens).toBeUndefined();
				expect(finish.outputTokens).toBeUndefined();

				// state.history.content should have ONLY the user message — the
				// absorbPart skip-path on null/primitive parts means no assistant
				// message lands.
				const state = yield* SubscriptionRef.get(session.state);
				expect(state.inputTokens).toBe(0);
				expect(state.outputTokens).toBe(0);
				expect(state.history.content).toHaveLength(1);
				expect((state.history.content[0] as { readonly role: string }).role).toBe("user");
			}).pipe(
				Effect.provide(
					stubLanguageModelStream([
						null,
						"a-bare-string",
						42,
						// Wrong shape: an object with no `type` field — still object/non-null,
						// so liftPart returns [LlmPart] without lifting; absorbPart sees no
						// recognised `type` and returns acc unchanged; captureUsage sees no
						// `type === "finish"` and returns null. (This case keeps absorbPart's
						// "unknown type" branch live but doesn't exercise the defensive guard
						// — included for completeness so the array is plausible.)
						{ somethingElse: true },
					] as ReadonlyArray<unknown>),
				),
			),
	);

	it.effect("a malformed stream that ends with a primitive finish-shaped value still completes (no usage)", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("ping"));
			const finish = events[events.length - 1] as Finish;
			expect(finish._tag).toBe("Finish");
			expect(finish.inputTokens).toBeUndefined();
		}).pipe(
			// One null and one primitive value — both hit the defensive guard in
			// captureUsage and liftPart. No assistant message accumulates.
			Effect.provide(stubLanguageModelStream([null, 0] as ReadonlyArray<unknown>)),
		),
	);

	it.effect("captureUsage returns null for a primitive 'part' but does not error the stream", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			// Exercises captureUsage's `typeof part !== "object" || part === null`
			// guard on a primitive number. Stream still completes; turnCount
			// increments because the pre-stream history update fires on every send.
			const result = yield* Stream.runCollect(session.send("x")).pipe(Effect.exit);
			expect(result._tag).toBe("Success");
			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
		}).pipe(Effect.provide(stubLanguageModelStream([3.14] as ReadonlyArray<unknown>))),
	);
});

describe("Session.send empty assistant turn does not append to history", () => {
	it.effect("a stream with zero recognised parts yields turnCount=1 and history=[user]", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("hello"));
			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
			expect(state.history.content).toHaveLength(1);
			expect((state.history.content[0] as { readonly role: string }).role).toBe("user");
		}).pipe(Effect.provide(stubLanguageModelStream([] as ReadonlyArray<unknown>))),
	);
});
