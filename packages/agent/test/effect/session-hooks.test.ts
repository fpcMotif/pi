/**
 * Tracer bullets for slice 30 — observer hooks on `Session.send` (ADR-0009's
 * last loop-wrapping item: "the loop wraps the provider stream with ... hooks").
 *
 * `Hooks` is a `Context.Reference` with a no-op default. `Session.send` taps
 * its final event stream and invokes `hooks.onAgentEvent` for every
 * `AgentEvent` the consumer sees — observer-only, in stream order.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { Prompt } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { COMPACTION_THRESHOLD } from "../../effect/compaction.js";
import { Hooks } from "../../effect/hooks.js";
import { Session } from "../../effect/session.js";
import { SessionState } from "../../effect/session-state.js";
import { recordingHooks } from "../../test-support/recording-hooks.js";
import { stubLanguageModelDual } from "../../test-support/stub-language-model-dual.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

const parts = [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "hello" },
	{ type: "text-end", id: "t1" },
];

describe("Session.send observer hooks", () => {
	it.effect("a provided Hooks observes every AgentEvent the stream emits, in order", () =>
		Effect.gen(function* () {
			const recording = recordingHooks();
			const session = yield* Session.empty;

			const emitted = yield* Stream.runCollect(session.send("hello")).pipe(
				Effect.provideService(Hooks, recording.hooks),
			);

			expect(emitted.length).toBeGreaterThan(0);
			expect(recording.events.map((e) => e._tag)).toEqual(emitted.map((e) => e._tag));
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect("the hook also observes the prepended CompactionApplied event", () =>
		Effect.gen(function* () {
			const recording = recordingHooks();
			const session = yield* Session.empty;

			const halfChars = (COMPACTION_THRESHOLD + 5000) * 2;
			const bigHistory = Prompt.make([
				{ role: "user", content: "u".repeat(halfChars) },
				{ role: "assistant", content: [{ type: "text", text: "a".repeat(halfChars) }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 3,
					history: bigHistory,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			yield* Stream.runDrain(session.send("next question")).pipe(Effect.provideService(Hooks, recording.hooks));

			expect(recording.events[0]._tag).toBe("CompactionApplied");
		}).pipe(Effect.provide(stubLanguageModelDual({ summaryText: "## Summary", streamParts: parts }))),
	);

	it.effect("with no Hooks provided, send uses the no-op default and emits normally", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			// No `Effect.provideService(Hooks, ...)` — proves the Reference default is
			// used and `send`'s R-channel does not require `Hooks`.
			const emitted = yield* Stream.runCollect(session.send("hello"));

			expect(emitted.length).toBeGreaterThan(0);
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);
});
