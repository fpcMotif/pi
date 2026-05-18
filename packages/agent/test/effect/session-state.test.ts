/**
 * Tracer bullet for `Session.state` (ADR-0009 -- observable per-session state).
 *
 * - `session.state` is a `SubscriptionRef<SessionState>` initialised to
 *   `SessionState.empty` (turnCount: 0).
 * - Each `Stream.runDrain(session.send(prompt))` increments `turnCount` by 1.
 * - The increment is atomic: a snapshot read after the stream completes
 *   reflects the new count.
 *
 * Deferred until later slices: history field on SessionState, model selection
 * field, accumulated usage / cost, pending tool calls, observable change
 * stream wiring (`SubscriptionRef.changes`).
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { Prompt } from "effect/unstable/ai";
import { describe, expect, it as vitestIt } from "vitest";

import { Session } from "../../effect/session.js";
import { SessionState } from "../../effect/session-state.js";
import { openAiStreamingLayer } from "../../test-support/openai-language-model.js";

describe("Session.state -- SubscriptionRef<SessionState>", () => {
	it.effect("Session.empty initialises state to SessionState.empty (turnCount: 0)", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			expect(session.state).toBeDefined();
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot).toBeInstanceOf(SessionState);
			expect(snapshot.turnCount).toBe(0);
		}),
	);

	it.effect("each send call increments turnCount, accumulating across sends", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			const initial = yield* SubscriptionRef.get(session.state);
			expect(initial.turnCount).toBe(0);

			yield* Stream.runDrain(session.send("first"));
			const after1 = yield* SubscriptionRef.get(session.state);
			expect(after1.turnCount).toBe(1);

			yield* Stream.runDrain(session.send("second"));
			const after2 = yield* SubscriptionRef.get(session.state);
			expect(after2.turnCount).toBe(2);

			yield* Stream.runDrain(session.send("third"));
			const after3 = yield* SubscriptionRef.get(session.state);
			expect(after3.turnCount).toBe(3);
		}).pipe(Effect.provide(openAiStreamingLayer("ok"))),
	);

	vitestIt("SessionState.with leaves omitted fields untouched", () => {
		// Direct unit test for the patch-field ??-fallback in `SessionState.with`.
		// Each runtime caller (compaction-step, attempt-stream, advance) currently
		// passes some subset of fields; the empty-patch case below exercises the
		// undefined-fallback branch on every field at once.
		const source = new SessionState({
			turnCount: 7,
			history: Prompt.make("hello"),
			inputTokens: 11,
			outputTokens: 13,
			compactionCount: 2,
		});
		const same = SessionState.with(source, {});
		expect(same.turnCount).toBe(7);
		expect(same.history).toBe(source.history);
		expect(same.inputTokens).toBe(11);
		expect(same.outputTokens).toBe(13);
		expect(same.compactionCount).toBe(2);
	});
});
