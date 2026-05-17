import { it } from "@effect/vitest";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { AiError } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { COMPACTION_THRESHOLD } from "../../effect/compaction.js";
import { Session } from "../../effect/session.js";
import { layerMemory as sessionStoreLayer } from "../../effect/stores/session-store.js";
import { stubLanguageModelDual } from "../../test-support/stub-language-model-dual.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

const appLayer = Layer.mergeAll(
	sessionStoreLayer,
	stubLanguageModelStream([{ type: "text-delta", id: "msg_1", delta: "ok" }]),
);

describe("Session.durable -- Session state persisted across Effect sessions", () => {
	it.effect("loads saved turnCount and persists subsequent sends", () =>
		Effect.gen(function* () {
			const first = yield* Session.durable("durable-session");

			yield* Stream.runDrain(first.send("one"));
			yield* Stream.runDrain(first.send("two"));

			const second = yield* Session.durable("durable-session");
			const loaded = yield* SubscriptionRef.get(second.state);
			expect(loaded.turnCount).toBe(2);

			yield* Stream.runDrain(second.send("three"));

			const third = yield* Session.durable("durable-session");
			const reloaded = yield* SubscriptionRef.get(third.state);
			expect(reloaded.turnCount).toBe(3);
		}).pipe(Effect.provide(appLayer)),
	);

	it.effect("persists the accepted turn before a compaction failure", () =>
		Effect.gen(function* () {
			const session = yield* Session.durable("durable-compaction-failure");
			const hugePrompt = "x".repeat((COMPACTION_THRESHOLD + 5000) * 4);

			const error = yield* Effect.flip(Stream.runDrain(session.send(hugePrompt)));
			expect(error._tag).toBe("CompactionError");

			const reloaded = yield* Session.durable("durable-compaction-failure");
			const snapshot = yield* SubscriptionRef.get(reloaded.state);
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content.some((message) => message.role === "user")).toBe(true);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					sessionStoreLayer,
					stubLanguageModelDual({
						summaryError: AiError.make({
							module: "stub",
							method: "generateText",
							reason: new AiError.RateLimitError({}),
						}),
						streamParts: [{ type: "text-delta", id: "msg_1", delta: "unused" }],
					}),
				),
			),
		),
	);
});
