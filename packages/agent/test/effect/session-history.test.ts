/**
 * Tracer bullet for multi-turn history accumulation in `Session.send`.
 *
 * - `SessionState.empty.history` is `Prompt.empty` (zero messages).
 * - Each `send(prompt)` (a) appends a `user` message with `prompt` to
 *   `state.history` BEFORE the upstream stream starts emitting, (b)
 *   accumulates text deltas as the stream flows, and (c) appends an
 *   `assistant` message with the assembled text after the stream completes.
 * - Two back-to-back sends produce 4 messages in `state.history.content`:
 *   `[user, assistant, user, assistant]`.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";

import { Session } from "../../effect/session.js";
import { openAiStreamingLayer } from "../../test-support/openai-language-model.js";

describe("Session.send accumulates user + assistant messages in state.history", () => {
	it.effect("initial history is empty", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.history.content).toHaveLength(0);
		}),
	);

	it.effect("two back-to-back sends accumulate to [user, assistant, user, assistant]", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hello"));
			const afterFirst = yield* SubscriptionRef.get(session.state);
			expect(afterFirst.history.content).toHaveLength(2);

			yield* Stream.runDrain(session.send("how are you"));
			const afterSecond = yield* SubscriptionRef.get(session.state);
			expect(afterSecond.history.content).toHaveLength(4);
			expect(afterSecond.history.content.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		}).pipe(Effect.provide(openAiStreamingLayer("hi back"))),
	);
});
