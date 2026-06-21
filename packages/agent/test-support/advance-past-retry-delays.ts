import { Effect } from "effect";
import { TestClock } from "effect/testing";

/**
 * Drive the `TestClock` past every pending retry-backoff delay so a forked
 * `Session.send` consumer can progress through its retry attempts
 * (`makeRetrySchedule` sleeps between attempts since PI-EFX-06).
 *
 * Each `TestClock.adjust` yields to other fibers before stepping the clock, so
 * one generous jump per expected sleep is enough; the two extra iterations
 * absorb scheduler lag where a retry registers its sleep one adjust late.
 * Use with the corpus recipe: `Effect.forkChild` the consuming effect, run
 * this, then `Fiber.join`.
 */
export const advancePastRetryDelays = (retries: number): Effect.Effect<void> =>
	Effect.gen(function* () {
		for (let i = 0; i < retries + 2; i++) {
			yield* TestClock.adjust("30 seconds");
		}
	});
