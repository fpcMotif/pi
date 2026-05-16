/**
 * Tracer bullet for the `Input = NewPrompt | Continue` discriminated union
 * accepted by `Session.send` (per ADR-0009).
 *
 * Three behaviors verified here:
 *
 * 1. **`send("string")`** stays backward-compatible — normalised internally
 *    to `new NewPrompt({ prompt })`. Existing tests across the suite already
 *    cover this implicitly; one explicit test pins it.
 * 2. **`send(new NewPrompt({ prompt }))`** behaves identically to the
 *    string form: appends a `user` message before the upstream opens.
 * 3. **`send(new Continue({}))`** does NOT append a user message; the
 *    upstream sees only the existing history, and a new `assistant` message
 *    lands on top of it. Useful for "keep talking" turns where the user
 *    doesn't have anything new to say.
 *
 * `Retry` is deferred to a follow-on slice (needs history rollback).
 */
import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";

import { Continue, NewPrompt } from "../../effect/agent-input.js";
import { Session } from "../../effect/session.js";
import { stubOpenAiClientStreaming } from "../../test-support/stub-openai-client-streaming.js";

const openAiStreamingLayer = (text: string) =>
	OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(Layer.provide(stubOpenAiClientStreaming({ text })));

describe("Session.send accepts string | NewPrompt | Continue", () => {
	it.effect("send(string) is normalised to NewPrompt — appends a user message", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("hello"));
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user", "assistant"]);
		}).pipe(Effect.provide(openAiStreamingLayer("hi"))),
	);

	it.effect("send(NewPrompt) behaves identically to send(string)", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send(new NewPrompt({ prompt: "hello" })));
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user", "assistant"]);
		}).pipe(Effect.provide(openAiStreamingLayer("hi"))),
	);

	it.effect("send(Continue) does NOT append a user message — history grows by exactly one assistant message", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("first"));
			const afterFirst = yield* SubscriptionRef.get(session.state);
			expect(afterFirst.history.content.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(afterFirst.turnCount).toBe(1);

			yield* Stream.runDrain(session.send(new Continue({})));
			const afterContinue = yield* SubscriptionRef.get(session.state);
			expect(afterContinue.history.content.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
			expect(afterContinue.turnCount).toBe(2);
		}).pipe(Effect.provide(openAiStreamingLayer("more text"))),
	);
});
