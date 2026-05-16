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
 * All three hooks are observer-only — they cannot mutate the input, the event,
 * or the loop. Mutating hooks (block a tool call, patch a tool result) remain
 * a deferred follow-on.
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
