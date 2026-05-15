/**
 * Tracer bullets for slice 29 — tool-call concurrency control on `Session.send`
 * (ADR-0009 sub-decision: "tool execution defaults to sequential; a future
 * opt-in `concurrency` parameter lets callers request parallelism per turn").
 *
 * The effect framework's `LanguageModel.streamText` defaults `concurrency` to
 * `"unbounded"` when omitted, so `Session.send` must pass an explicit
 * `concurrency: 1` to keep the sequential default — and forward the opt-in
 * value when a caller provides one.
 *
 * pi's contract is "set the right default + forward the opt-in"; the actual
 * parallel tool resolution is framework behavior, tested upstream. So these
 * tests assert on the options `Session.send` passes to `streamText`.
 */
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from "effect";
import { Prompt } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { COMPACTION_THRESHOLD } from "../../effect/compaction.js";
import { Session } from "../../effect/session.js";
import { SessionState } from "../../effect/session-state.js";
import { recordingLanguageModelStream } from "../../test-support/recording-language-model-stream.js";
import { stubLanguageModelDual } from "../../test-support/stub-language-model-dual.js";

const parts = [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "ok" },
	{ type: "text-end", id: "t1" },
];

describe("Session.send tool-call concurrency", () => {
	it.effect("defaults to sequential (concurrency: 1) when no concurrency arg is given", () =>
		Effect.gen(function* () {
			const recording = recordingLanguageModelStream(parts);
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hello")).pipe(Effect.provide(recording.layer));

			expect(recording.calls).toHaveLength(1);
			expect(recording.calls[0].concurrency).toBe(1);
		}),
	);

	it.effect("forwards an explicit 'unbounded' opt-in to streamText", () =>
		Effect.gen(function* () {
			const recording = recordingLanguageModelStream(parts);
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hello", undefined, "unbounded")).pipe(Effect.provide(recording.layer));

			expect(recording.calls[0].concurrency).toBe("unbounded");
		}),
	);

	it.effect("forwards a numeric concurrency opt-in to streamText", () =>
		Effect.gen(function* () {
			const recording = recordingLanguageModelStream(parts);
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hello", undefined, 4)).pipe(Effect.provide(recording.layer));

			expect(recording.calls[0].concurrency).toBe(4);
		}),
	);
});

describe("Session.send concurrent-send safety during compaction", () => {
	it.effect("a send that commits while compaction is in flight is not lost", () =>
		Effect.gen(function* () {
			// `generateText` (the compaction summary) parks on this latch, holding
			// the first send's setup "in flight" while the second send is forked.
			const latch = yield* Deferred.make<void>();
			const layer = stubLanguageModelDual({
				summaryText: "## Summary",
				summaryLatch: Deferred.await(latch),
				streamParts: parts,
			});

			const session = yield* Session.empty;

			// Over-threshold history so the first send triggers compaction.
			const halfChars = (COMPACTION_THRESHOLD + 5000) * 2;
			const bigHistory = Prompt.make([
				{ role: "user", content: "u".repeat(halfChars) },
				{ role: "assistant", content: [{ type: "text", text: "a".repeat(halfChars) }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 1,
					history: bigHistory,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			const fiberA = yield* Effect.forkChild(
				Stream.runDrain(session.send("question A")).pipe(Effect.provide(layer)),
			);
			const fiberB = yield* Effect.forkChild(
				Stream.runDrain(session.send("question B")).pipe(Effect.provide(layer)),
			);

			// Release the in-flight compaction summary and let both sends finish.
			yield* Deferred.succeed(latch, undefined);
			yield* Fiber.join(fiberA);
			yield* Fiber.join(fiberB);

			// Both user prompts must survive — the stale-snapshot race would
			// overwrite history with a compacted copy that drops the concurrent turn.
			const after = yield* SubscriptionRef.get(session.state);
			const userBlobs = after.history.content.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
			expect(userBlobs.some((b) => b.includes("question A"))).toBe(true);
			expect(userBlobs.some((b) => b.includes("question B"))).toBe(true);
			expect(after.turnCount).toBe(3);
		}),
	);
});
