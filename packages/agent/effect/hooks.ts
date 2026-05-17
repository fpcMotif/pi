/**
 * Observer hooks for the `Session.send` loop. The original observer slice (30)
 * shipped `onAgentEvent`; slice 37 adds the lifecycle siblings `onStart` and
 * `onShutdown`, working toward the ADR-0014 host-lifecycle target.
 *
 * `Hooks` is a `Context.Reference` with a no-op default — so `Session.send`'s
 * `R` channel is unchanged when nothing provides it, and a host / extension /
 * test overrides it via `Effect.provideService(Hooks, customHooks)`. Same
 * pattern as `Tracer.Tracer` (slice 25).
 *
 * All three hooks are observer-only — they cannot mutate the input, the
 * event, the loop's value, or the loop's exit. Their typed signature is
 * `Effect<void, never, never>`, so typed failures are impossible by
 * construction. Defects (`Effect.die`, unchecked throws) inside an underlying
 * hook are absorbed by `composeHooks` (via `Effect.catchDefect`) and logged
 * at warning level; the loop continues unaffected. See ADR-0018 for the
 * design evolution (initial fail-fast → defect-isolation, after the
 * durable-partial-turn blast radius was surfaced in adversarial review).
 * Mutating hooks (block a tool call, patch a tool result) remain a deferred
 * follow-on.
 */
import { Context, Effect, type Exit } from "effect";

import type { AgentError } from "./agent-error.js";
import type { AgentEvent } from "./agent-event.js";
import type { Input } from "./agent-input.js";

export interface Hooks {
	/**
	 * Invoked once per `AgentEvent` the `Session.send` stream emits, in stream
	 * order (including prepended orchestration events like `CompactionApplied`).
	 * Observer-only — the returned Effect's value is discarded and it cannot
	 * change the event or the loop.
	 */
	readonly onAgentEvent: (event: AgentEvent) => Effect.Effect<void>;

	/**
	 * Invoked once per `send`, at stream open (i.e. when the consumer first
	 * pulls from the stream), with the normalised `Input` value. Runs BEFORE
	 * history mutation / compaction / the retry boundary, so host code can
	 * record turn metadata or pre-flight side effects.
	 *
	 * Observer-only — the returned Effect's value is discarded and the input
	 * is NOT replaced from the hook's return.
	 */
	readonly onStart: (input: Input) => Effect.Effect<void>;

	/**
	 * Invoked once per `send` when the stream completes — success, failure, or
	 * interruption. Carries the stream's `Exit` so the host can branch on
	 * `Exit.isSuccess` (clean finish) vs `Exit.isFailure` (a typed
	 * `CompactionError` / `LlmError` from the loop) vs an interrupt cause.
	 * Wired via `Stream.onExit`, so it fires for every termination path.
	 *
	 * Observer-only — it cannot reopen the stream or change its outcome.
	 */
	readonly onShutdown: (exit: Exit.Exit<unknown, AgentError>) => Effect.Effect<void>;
}

/**
 * The `Hooks` service. Default is a no-op for every hook; provide a custom
 * implementation with `Effect.provideService(Hooks, ...)`. TypeScript
 * parameter contravariance means an impl that ignores `onShutdown`'s `exit`
 * argument (`onShutdown: () => Effect.void`) still satisfies the typed shape,
 * so callers can opt into the exit only when they care about it.
 */
export const Hooks: Context.Reference<Hooks> = Context.Reference<Hooks>("pi/Hooks", {
	defaultValue: (): Hooks => ({
		onAgentEvent: () => Effect.void,
		onStart: () => Effect.void,
		onShutdown: () => Effect.void,
	}),
});

/**
 * Compose multiple `Hooks` implementations into one (slice 39 — the lifecycle-
 * hooks adapter for host-specific lifecycle composition, per ADR-0014 and
 * ADR-0018). Each hook method on the result fans out to every supplied
 * `Hooks` in pass-order, sequentially. Hooks are observer-only on the typed
 * path (`Effect<void, never, never>`); defects (`Effect.die`, unchecked
 * throws) inside an underlying hook are **absorbed** via `Effect.catchDefect`
 * and logged at warning level — subsequent hooks for that event STILL run,
 * and the composed hook's caller (`Session.send`) is never affected. This
 * isolates observer bugs from the loop: a buggy logging / telemetry / UI
 * hook cannot leave a durable session in a partial-turn state. See ADR-0018
 * for the rationale (the original fail-fast design was reversed after
 * adversarial review surfaced the durable-partial-turn blast radius).
 * `composeHooks()` (no args) yields a no-op `Hooks` equivalent to the
 * `Context.Reference` default.
 *
 * @example
 * ```ts
 * const composed = composeHooks(loggingHooks, telemetryHooks, uiHooks)
 * yield* Stream.runDrain(session.send("hi")).pipe(
 *   Effect.provideService(Hooks, composed)
 * )
 * // every event fans out to all three observers; a defect in any one is
 * // logged at warning level and absorbed — the other two still observe.
 * ```
 */
export const composeHooks = (...hooks: ReadonlyArray<Hooks>): Hooks => {
	// `Effect.suspend` defers the thunk into the Effect runtime, so a hook that
	// throws *synchronously* (before returning its Effect) lands as a defect
	// inside the Effect runtime and is then caught by `Effect.catchDefect`. If
	// we wrapped only `h.onX(arg)` directly, a `throw` during method invocation
	// would propagate as an uncaught exception and bypass the isolation —
	// reintroducing the durable-partial-turn risk ADR-0018 exists to close.
	const isolate = (make: () => Effect.Effect<void>): Effect.Effect<void> =>
		Effect.suspend(make).pipe(
			Effect.catchDefect((defect) => Effect.logWarning("composeHooks: observer hook defect absorbed", defect)),
		);
	return {
		onAgentEvent: (event) => Effect.forEach(hooks, (h) => isolate(() => h.onAgentEvent(event)), { discard: true }),
		onStart: (input) => Effect.forEach(hooks, (h) => isolate(() => h.onStart(input)), { discard: true }),
		onShutdown: (exit) => Effect.forEach(hooks, (h) => isolate(() => h.onShutdown(exit)), { discard: true }),
	};
};
