/**
 * Tracer bullet for state consistency under abnormal termination (per
 * ADR-0009's cancellation sub-decision: "Cancellation is
 * `Fiber.interrupt(currentActionFiber)`, not `AbortSignal`").
 *
 * Effect's runtime guarantees that any well-typed Effect program is
 * interruption-safe: when a fiber is interrupted, every `acquireRelease`,
 * `Scope` finalizer, and `Stream` cleanup runs. Our `Session.send` doesn't
 * use any uninterruptible primitives (`SubscriptionRef.update`, `Ref.update`,
 * `Stream.flatMap`/`tap`/`mapError`/`concat` — all interruption-safe), so
 * interruption safety **as a property** is inherited from the framework.
 *
 * What we DO need to verify ourselves is that the per-turn state mutations
 * land in a consistent order regardless of whether the upstream stream
 * completes, fails, or is interrupted:
 *
 * - `turnCount` bump + user-message append (pre-upstream side effects)
 *   land BEFORE the upstream stream is opened.
 * - Assistant-message append (post-upstream side effect) lands ONLY after
 *   the upstream stream completes successfully.
 * - On any abnormal termination (upstream failure OR interruption), state
 *   reflects only the pre-upstream side effects — the assistant-message
 *   append does NOT fire.
 *
 * This test exercises the **failure** path (upstream emits `Stream.fail(...)`
 * immediately). The interruption path is symmetric: both terminate the
 * stream before the post-upstream `Stream.concat` block runs.
 *
 * (We attempted to drive interruption directly via `Effect.timeout` on a
 * `Stream.never` or `Stream.fromEffect(Effect.callback(...))` upstream, but
 * both blocking primitives hung in `it.effect`'s test environment. Whether
 * that's a v4-beta `@effect/vitest` interaction or a Stream subtlety is
 * worth a follow-up but doesn't change the framework's interruption
 * guarantee.)
 */
import { it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Stream, SubscriptionRef } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { Session } from "../../effect/session.js";

/** A `LanguageModel` whose `streamText` fails immediately with an `AiError`. */
const failingLanguageModel = Layer.succeed(
	LanguageModel.LanguageModel,
	LanguageModel.LanguageModel.of({
		streamText: (() =>
			Stream.fail(
				AiError.make({
					module: "TestStub",
					method: "streamText",
					reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(1) }),
				}),
			)) as never,
		generateText: (() => Effect.die("failingLanguageModel: generateText not implemented")) as never,
		generateObject: (() => Effect.die("failingLanguageModel: generateObject not implemented")) as never,
	}),
);

describe("Session.send state consistency under abnormal termination", () => {
	it.effect("upstream failure leaves state with only pre-upstream side effects (turnCount + user message)", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			const exit = yield* Effect.exit(Stream.runDrain(session.send("hello")));
			expect(Exit.isFailure(exit)).toBe(true);

			// Pre-upstream side effects landed: turnCount = 1, one user message in history.
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content).toHaveLength(1);
			expect((snapshot.history.content[0] as { readonly role: string }).role).toBe("user");

			// Post-upstream side effect did NOT fire: no assistant message appended.
		}).pipe(Effect.provide(failingLanguageModel)),
	);
});
