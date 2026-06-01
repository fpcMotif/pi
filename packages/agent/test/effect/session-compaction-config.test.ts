/**
 * Tracer bullets for slice 32 — configurable + observable compaction.
 *
 * - `SessionState.compactionCount` — an observable count of how many times the
 *   session has compacted, bumped each time compaction fires.
 * - `Session.make(config?)` — `{ compactionThreshold?, keepRecentTokens? }`
 *   overrides the hardcoded module defaults; `Session.empty` delegates to
 *   `Session.make({})`.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { Prompt } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { COMPACTION_THRESHOLD } from "../../effect/compaction.js";
import { Session } from "../../effect/session.js";
import { SessionState } from "../../effect/session-state.js";
import { stubLanguageModelDual } from "../../test-support/stub-language-model-dual.js";

const streamParts = [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "ok" },
	{ type: "text-end", id: "t1" },
];

const overThresholdHistory = (): Prompt.Prompt => {
	const halfChars = (COMPACTION_THRESHOLD + 5000) * 2;
	return Prompt.make([
		{ role: "user", content: "u".repeat(halfChars) },
		{ role: "assistant", content: [{ type: "text", text: "a".repeat(halfChars) }] },
	] as never);
};

describe("SessionState.compactionCount", () => {
	it("SessionState.empty.compactionCount is 0", () => {
		expect(SessionState.empty.compactionCount).toBe(0);
	});

	it.effect("bumps each time compaction fires", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 3,
					history: overThresholdHistory(),
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			yield* Stream.runDrain(session.send("next question"));

			const after = yield* SubscriptionRef.get(session.state);
			expect(after.compactionCount).toBe(1);
		}).pipe(Effect.provide(stubLanguageModelDual({ summaryText: "## Summary", streamParts }))),
	);
});

describe("Session.make(config) — configurable compaction", () => {
	it.effect("a low compactionThreshold + keepRecentTokens are honored over the module defaults", () =>
		Effect.gen(function* () {
			// Six ~25-token messages → ~150 tokens total. Well under the default
			// COMPACTION_THRESHOLD (100_000), so the default config would NOT compact.
			const messages = Array.from({ length: 6 }, (_, i) =>
				i % 2 === 0
					? { role: "user", content: "x".repeat(100) }
					: { role: "assistant", content: [{ type: "text", text: "x".repeat(100) }] },
			);
			const history = Prompt.make(messages as never);

			const session = yield* Session.make({ compactionThreshold: 50, keepRecentTokens: 40 });
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 1,
					history,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			const events = yield* Stream.runCollect(session.send("next question"));

			// Threshold honored: compaction fired on a history the default would skip.
			expect(events[0]._tag).toBe("CompactionApplied");
			// keepRecentTokens honored: the low value forced a real split — the
			// default 20_000 would keep everything (summarizedMessageCount === 0).
			expect(events[0]._tag === "CompactionApplied" && events[0].summarizedMessageCount).toBeGreaterThan(0);
		}).pipe(Effect.provide(stubLanguageModelDual({ summaryText: "## Summary", streamParts }))),
	);

	it.effect("Session.empty delegates to make({}) — a fresh session at SessionState.empty", () =>
		Effect.gen(function* () {
			const a = yield* Session.empty;
			const b = yield* Session.empty;

			const stateA = yield* SubscriptionRef.get(a.state);
			expect(stateA).toEqual(SessionState.empty);
			// Each run produces a fresh `state` ref — sessions are independent.
			expect(a.state).not.toBe(b.state);
		}),
	);
});
