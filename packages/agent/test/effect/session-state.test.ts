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
import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";

import { Session } from "../../effect/session.js";
import { SessionState } from "../../effect/session-state.js";
import { stubOpenAiClientStreaming } from "../../test-support/stub-openai-client-streaming.js";

const openAiStreamingLayer = (text: string, chunkCount = 1) =>
	OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(Layer.provide(stubOpenAiClientStreaming({ text, chunkCount })));

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
});
