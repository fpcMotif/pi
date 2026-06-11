/**
 * Tracer bullet for exponential jittered backoff on the LLM retry schedule
 * (PI-EFX-06).
 *
 * `makeRetrySchedule` is `Schedule.exponential("250 millis")` → jittered
 * (80–120%) → intersected with `Schedule.recurs(maxRetries)` → gated by the
 * `isRetryable` predicate. These tests pin the delay ladder exactly:
 *
 * - With `Random.Random` stubbed so `nextDoubleUnsafe() = 0.5`, the jitter
 *   factor is exactly 1.0 (`0.8·(1−r) + 1.2·r`), so re-attempts fire at
 *   250ms → 500ms → 1000ms after each failure — not a millisecond sooner.
 * - With `nextDoubleUnsafe() = 1`, the first delay stretches to the 120%
 *   jitter ceiling (300ms), proving the jitter is wired through `Random`.
 *
 * Recipe: fork the consumer, advance the `TestClock` just below then past
 * each expected delay, and assert attempt counts via a `Ref` bumped on every
 * `streamText` call. `settle` (a burst of `Effect.yieldNow`) runs between
 * adjust and assert because `TestClock.adjust` can return before the woken
 * fiber has re-attempted and registered its next sleep.
 */
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Random, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { LlmError } from "../../effect/agent-error.js";
import { Session } from "../../effect/session.js";
import { advancePastRetryDelays } from "../../test-support/advance-past-retry-delays.js";
import { dieUnimplemented } from "../../test-support/die-unimplemented.js";

const rateLimit = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.RateLimitError({}),
});

/** A LanguageModel whose `streamText` always fails retryably, counting calls. */
const countingRateLimitedModel = (attempts: Ref.Ref<number>) =>
	Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: dieUnimplemented("countingRateLimitedModel", "generateText"),
			generateObject: dieUnimplemented("countingRateLimitedModel", "generateObject"),
			streamText: (() =>
				Stream.unwrap(Ref.update(attempts, (n) => n + 1).pipe(Effect.as(Stream.fail(rateLimit))))) as never,
		}),
	);

const constantRandom = (value: number) => ({
	nextIntUnsafe: () => 0,
	nextDoubleUnsafe: () => value,
});

const settle = Effect.gen(function* () {
	for (let i = 0; i < 100; i++) {
		yield* Effect.yieldNow;
	}
});

describe("makeRetrySchedule backs off exponentially with jitter (PI-EFX-06)", () => {
	it.effect("re-attempts fire at exactly 250ms → 500ms → 1000ms when the jitter factor is stubbed to 1.0", () =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0);
			const session = yield* Session.empty;

			const fiber = yield* Effect.forkChild(
				Effect.flip(Stream.runDrain(session.send("hello"))).pipe(
					Effect.provide(countingRateLimitedModel(attempts)),
					Effect.provideService(Random.Random, constantRandom(0.5)),
				),
			);

			// The first attempt fires immediately — backoff only delays re-attempts.
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(1);

			// Retry 1 waits the full 250ms base delay.
			yield* TestClock.adjust("249 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(1);
			yield* TestClock.adjust("1 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(2);

			// Retry 2 doubles to 500ms.
			yield* TestClock.adjust("499 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(2);
			yield* TestClock.adjust("1 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(3);

			// Retry 3 doubles to 1000ms.
			yield* TestClock.adjust("999 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(3);
			yield* TestClock.adjust("1 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(4);

			// Cap exhausted (initial + 3 retries): the last error propagates with
			// no further attempts and no further sleeps.
			const err = yield* Fiber.join(fiber);
			expect(err).toBeInstanceOf(LlmError);
			expect(yield* Ref.get(attempts)).toBe(4);
		}),
	);

	it.effect("jitter stretches the first delay to the 120% ceiling (300ms) when nextDoubleUnsafe() = 1", () =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0);
			const session = yield* Session.empty;

			const fiber = yield* Effect.forkChild(
				Effect.flip(Stream.runDrain(session.send("hello"))).pipe(
					Effect.provide(countingRateLimitedModel(attempts)),
					Effect.provideService(Random.Random, constantRandom(1)),
				),
			);

			// 299ms — past the un-jittered 250ms base, but below the 1.2× ceiling.
			yield* TestClock.adjust("299 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(1);
			yield* TestClock.adjust("1 millis");
			yield* settle;
			expect(yield* Ref.get(attempts)).toBe(2);

			yield* advancePastRetryDelays(2);
			const err = yield* Fiber.join(fiber);
			expect(err).toBeInstanceOf(LlmError);
			expect(yield* Ref.get(attempts)).toBe(4);
		}),
	);
});
