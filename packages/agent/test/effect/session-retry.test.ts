/**
 * Tracer bullet for `Session.send(new Retry({}))`, the third `Input` variant
 * per ADR-0009.
 *
 * Behavior:
 *
 * - Rolls `state.history` back to the last `user` message — dropping the
 *   trailing assistant turn (and any in-content tool-call / tool-result
 *   parts the previous slice put there) before opening the upstream.
 * - Calls the LLM with the rolled-back history (same prompt as last time).
 * - Appends the new assistant message on top of the rolled-back history.
 * - `turnCount` still bumps (each Retry is a new send).
 *
 * Net effect: history `[user, assistant]` after one `send(...)` followed by
 * a `send(Retry)` is `[user, assistant']` — the prior assistant message was
 * replaced, not appended next to.
 */
import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";

import { Retry } from "../../effect/agent-input.js";
import { Session } from "../../effect/session.js";
import { stubOpenAiClientStreaming } from "../../test-support/stub-openai-client-streaming.js";

const openAiStreamingLayer = (text: string) =>
	OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(Layer.provide(stubOpenAiClientStreaming({ text })));

describe("Session.send(Retry) rolls history back to the last user message and re-runs", () => {
	it.effect("after NewPrompt then Retry, history has [user, assistant'] (length 2) and turnCount is 2", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hello"));
			const afterFirst = yield* SubscriptionRef.get(session.state);
			expect(afterFirst.history.content.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(afterFirst.turnCount).toBe(1);

			yield* Stream.runDrain(session.send(new Retry({})));
			const afterRetry = yield* SubscriptionRef.get(session.state);

			// Still exactly 2 messages — the old assistant was rolled back, new one appended.
			expect(afterRetry.history.content).toHaveLength(2);
			expect(afterRetry.history.content.map((m) => m.role)).toEqual(["user", "assistant"]);

			// The user message survived the rollback intact.
			const userMsg = afterRetry.history.content[0] as { readonly role: string };
			expect(userMsg.role).toBe("user");

			// turnCount bumped (each Retry is still a "send"; sequence numbering reflects activity, not novelty).
			expect(afterRetry.turnCount).toBe(2);
		}).pipe(Effect.provide(openAiStreamingLayer("hi back"))),
	);

	it.effect("Retry on empty history is a no-op rollback (no user to roll back to)", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send(new Retry({})));
			const snapshot = yield* SubscriptionRef.get(session.state);

			// turnCount still bumps (we did call send), but history was empty going in
			// and ends with just an assistant message (the LLM was called with empty prompt).
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["assistant"]);
		}).pipe(Effect.provide(openAiStreamingLayer("hi"))),
	);
});
