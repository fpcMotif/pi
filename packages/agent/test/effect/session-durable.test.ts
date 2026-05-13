import { it } from "@effect/vitest";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";

import { Session } from "../../effect/session.js";
import { layerMemory as sessionStoreLayer } from "../../effect/stores/session-store.js";
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
});
