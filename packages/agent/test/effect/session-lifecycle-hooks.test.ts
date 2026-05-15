/**
 * Tracer bullet for lifecycle hooks (slices 37 + 38 — extends slice 30's
 * observer-only `Hooks` toward the ADR-0014 host-lifecycle target).
 *
 * `Hooks` gains two siblings to `onAgentEvent`:
 *
 * - `onStart(input)` — fired once per `send`, AT stream open (i.e. when the
 *   consumer first pulls from the stream), with the normalized `Input`. Runs
 *   before history mutation / compaction / the retry boundary so host code
 *   can record turn metadata or pre-flight side effects.
 * - `onShutdown(exit)` — fired once per `send` when the stream completes —
 *   whether by success, failure, or interruption — carrying the typed `Exit`
 *   so the host can branch on `Exit.isSuccess` vs `Exit.isFailure` (slice 38
 *   refinement of slice 37's argument-less hook). Wired via `Stream.onExit`
 *   so a failure (e.g. `CompactionError`) still triggers it.
 *
 * Both stay observer-only — they cannot block, mutate the input, or change
 * the loop. Mutating hooks (tool-call approval, result patching) remain a
 * deferred follow-on.
 */
import { it } from "@effect/vitest";
import { Cause, Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import { NewPrompt } from "../../effect/agent-input.js";
import { Hooks } from "../../effect/hooks.js";
import { Session } from "../../effect/session.js";
import { recordingHooks } from "../../test-support/recording-hooks.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";
import { stubLanguageModelStreamScripted } from "../../test-support/stub-language-model-stream-scripted.js";
import { AiError } from "effect/unstable/ai";

const parts = [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "answer" },
	{ type: "text-end", id: "t1" },
];

const auth = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
});

describe("Session.send lifecycle hooks", () => {
	it.effect("onStart fires once at stream open with the normalised Input", () =>
		Effect.gen(function* () {
			const recording = recordingHooks();
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hello")).pipe(Effect.provideService(Hooks, recording.hooks));

			expect(recording.startInputs).toHaveLength(1);
			const first = recording.startInputs[0];
			expect(first._tag).toBe("NewPrompt");
			expect(first._tag === "NewPrompt" && first.prompt).toBe("hello");
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect("onStart preserves an explicit Input variant", () =>
		Effect.gen(function* () {
			const recording = recordingHooks();
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send(new NewPrompt({ prompt: "structured" }))).pipe(
				Effect.provideService(Hooks, recording.hooks),
			);

			expect(recording.startInputs[0]._tag).toBe("NewPrompt");
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect("onShutdown fires once on a successful stream and the Exit is Success", () =>
		Effect.gen(function* () {
			const recording = recordingHooks();
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hello")).pipe(Effect.provideService(Hooks, recording.hooks));

			expect(recording.shutdownExits).toHaveLength(1);
			expect(recording.shutdownExits[0]._tag).toBe("Success");
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect("onShutdown fires once on a stream that errors out and the Exit is Failure(LlmError)", () =>
		Effect.gen(function* () {
			const recording = recordingHooks();
			const session = yield* Session.empty;

			// AuthenticationError is non-retryable — propagates after the single attempt.
			yield* Effect.flip(Stream.runDrain(session.send("hello"))).pipe(Effect.provideService(Hooks, recording.hooks));

			// `Stream.onExit`-backed shutdown fires on failure too, and the Exit
			// carries the typed AgentError union (here an LlmError wrapping an AuthenticationError).
			expect(recording.shutdownExits).toHaveLength(1);
			const exit = recording.shutdownExits[0];
			expect(exit._tag).toBe("Failure");
			if (exit._tag === "Failure") {
				const error = Cause.findErrorOption(exit.cause);
				expect(error._tag).toBe("Some");
				if (error._tag === "Some") {
					expect((error.value as { readonly _tag: string })._tag).toBe("LlmError");
				}
			}
		}).pipe(Effect.provide(stubLanguageModelStreamScripted([{ type: "error", error: auth }]))),
	);

	it.effect("with no Hooks provided, lifecycle paths use the no-op default", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			// No `Effect.provideService(Hooks, ...)` — proves the Reference's
			// default fills both `onStart` and `onShutdown` without forcing the
			// consumer to provide a `Hooks` value.
			yield* Stream.runDrain(session.send("hello"));
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);
});
