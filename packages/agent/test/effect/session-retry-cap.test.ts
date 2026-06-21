/**
 * Tracer bullet for a configurable transient-error retry cap (slice 35).
 *
 * Closes out the long-deferred "configurable retry policy" item: `SessionConfig`
 * now carries `maxLlmRetries`. `Session.make({ maxLlmRetries })` lets a caller
 * raise, lower, or zero out the cap; `Session.empty` keeps the historical
 * default of 3 (initial attempt + 3 retries).
 *
 * Each test uses `stubLanguageModelStreamScripted`, whose internal cursor dies
 * loudly when called past the script length — so a script of length N proves
 * *exactly* N upstream attempts happened, no more, no fewer.
 *
 * Behaviour:
 *
 * - `Session.make({ maxLlmRetries: 1 })` — initial attempt + 1 retry = 2 tries.
 *   A 2-error script exhausts the cap and the last error propagates. A 3rd
 *   call (which the hardcoded default of 3 would make) would die on the
 *   script-end path.
 * - `Session.make({ maxLlmRetries: 0 })` — no retries: a 1-error script fails
 *   immediately after the single attempt.
 * - `Session.empty` — unchanged default of 3: three failures then a success
 *   (4 tries) still resolves.
 */
import { it } from "@effect/vitest";
import { Effect, Fiber, Stream, SubscriptionRef } from "effect";
import { AiError } from "effect/unstable/ai";
import { describe, expect } from "vitest";
import { LlmError } from "../../effect/agent-error.js";
import { Session } from "../../effect/session.js";
import { advancePastRetryDelays } from "../../test-support/advance-past-retry-delays.js";
import { stubLanguageModelStreamScripted } from "../../test-support/stub-language-model-stream-scripted.js";

const rateLimit = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.RateLimitError({}),
});

const finishPart = (input: number, output: number) => ({
	type: "finish" as const,
	reason: "stop" as const,
	usage: {
		inputTokens: { uncached: undefined, total: input, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: output, text: undefined, reasoning: undefined },
	},
	response: undefined,
});

function expectLlmError(err: unknown): LlmError {
	expect(err).toBeInstanceOf(LlmError);
	if (!(err instanceof LlmError)) {
		throw new Error(`Expected LlmError, got ${String(err)}`);
	}
	return err;
}

describe("Session.make({ maxLlmRetries }) — configurable transient-error retry cap", () => {
	it.effect("maxLlmRetries: 1 caps the loop at 2 tries (initial + 1 retry)", () =>
		Effect.gen(function* () {
			const session = yield* Session.make({ maxLlmRetries: 1 });
			const fiber = yield* Effect.forkChild(Effect.flip(Stream.runDrain(session.send("hello"))));
			yield* advancePastRetryDelays(1);
			const err = yield* Fiber.join(fiber);

			const llmError = expectLlmError(err);
			expect((llmError.aiError as { readonly reason: { readonly _tag: string } }).reason._tag).toBe(
				"RateLimitError",
			);

			// Pre-stream effects landed once; no assistant message.
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user"]);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
				]),
			),
		),
	);

	it.effect("maxLlmRetries: 0 disables retries — fails after the single attempt", () =>
		Effect.gen(function* () {
			const session = yield* Session.make({ maxLlmRetries: 0 });
			const err = yield* Effect.flip(Stream.runDrain(session.send("hello")));

			expectLlmError(err);
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
		}).pipe(Effect.provide(stubLanguageModelStreamScripted([{ type: "error", error: rateLimit }]))),
	);

	it.effect("Session.empty keeps the default cap of 3 — three failures then a success resolves", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const fiber = yield* Effect.forkChild(Stream.runCollect(session.send("hello")));
			yield* advancePastRetryDelays(3);
			const events = yield* Fiber.join(fiber);

			// The success step's script emits two parts (text-delta + finish), each
			// lifted to one LlmPart, then the trailing pi Finish event.
			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "LlmPart", "Finish"]);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					// initial + 3 retries = 4 tries; the 4th succeeds.
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
					{ type: "parts", parts: [{ type: "text-delta", id: "msg_1", delta: "ok" }, finishPart(1, 2)] },
				]),
			),
		),
	);
});
