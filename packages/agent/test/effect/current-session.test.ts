/**
 * `CurrentSession` — the ADR-0009 Session promoted to a Context.Service
 * (ADR-0020 decision 4). The service is the seam: hosts resolve one session
 * per runtime scope, tests swap in fakes without a LanguageModel in sight.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";

import { Finish } from "../../effect/agent-event.js";
import { CurrentSession, layerDurable, layerEphemeral } from "../../effect/current-session.js";
import type { Session } from "../../effect/session.js";
import { SessionState } from "../../effect/session-state.js";
import { layerMemory, SessionStore } from "../../effect/stores/session-store.js";
import { stubLanguageModel } from "../../test-support/stub-language-model.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

describe("CurrentSession", () => {
	it.effect("layerEphemeral provides a working session", () =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			const before = yield* SubscriptionRef.get(session.state);
			assert.strictEqual(before.turnCount, 0);

			const events = yield* Stream.runCollect(session.send("hello"));
			assert.isTrue(events.length > 0);
			assert.instanceOf(events[events.length - 1], Finish);

			const after = yield* SubscriptionRef.get(session.state);
			assert.strictEqual(after.turnCount, 1);
		}).pipe(Effect.provide(Layer.mergeAll(layerEphemeral(), stubLanguageModel({ text: "hi" })))),
	);

	it.effect("layerEphemeral forwards per-session config", () =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			const events = yield* Stream.runCollect(session.send("hello"));
			assert.instanceOf(events[events.length - 1], Finish);
		}).pipe(
			Effect.provide(Layer.mergeAll(layerEphemeral({ maxLlmRetries: 0 }), stubLanguageModel({ text: "hi" }))),
		),
	);

	it.effect("the layer is memoized: one session per scope", () =>
		Effect.gen(function* () {
			const first = yield* CurrentSession;
			const second = yield* CurrentSession;
			assert.strictEqual(first, second);
		}).pipe(Effect.provide(layerEphemeral())),
	);

	it.effect("layerDurable persists the completed turn — including the assistant reply", () =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			yield* Stream.runDrain(session.send("hello"));

			const store = yield* SessionStore;
			const stored = yield* store.load("durable-current");
			assert.isTrue(Option.isSome(stored));
			const state = Option.getOrThrow(stored);
			assert.strictEqual(state.turnCount, 1);
			// The final-snapshot persist (Stream.onExit success path) must
			// capture the assistant turn, not just the accepted user turn.
			const roles = state.history.content.map((message) => message.role);
			assert.deepStrictEqual(roles, ["user", "assistant"]);
		}).pipe(
			Effect.provide(
				(() => {
					const storeLayer = layerMemory;
					return Layer.mergeAll(
						layerDurable("durable-current").pipe(Layer.provide(storeLayer)),
						storeLayer,
						stubLanguageModelStream([{ type: "text-delta", id: "msg_1", delta: "hi" }]),
					);
				})(),
			),
		),
	);

	it.effect("a fake Session layer swaps in with no LanguageModel requirement", () =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			const events = yield* Stream.runCollect(session.send("anything"));
			assert.strictEqual(events.length, 1);
			assert.instanceOf(events[0], Finish);
			const state = yield* SubscriptionRef.get(session.state);
			assert.strictEqual(state.turnCount, 0);
		}).pipe(
			Effect.provide(
				Layer.effect(
					CurrentSession,
					Effect.gen(function* () {
						const state = yield* SubscriptionRef.make(SessionState.empty);
						const fake: Session = {
							state,
							send: () => Stream.succeed(new Finish({})),
						};
						return CurrentSession.of(fake);
					}),
				),
			),
		),
	);
});
