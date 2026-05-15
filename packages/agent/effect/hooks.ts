/**
 * Observer hooks for the `Session.send` loop (slice 30, ADR-0009 "wrapping" —
 * the last loop-wrapping item after compaction, retry, and telemetry).
 *
 * `Hooks` is a `Context.Reference` with a no-op default — so `Session.send`'s
 * `R` channel is unchanged when nothing provides it, and a host / extension /
 * test overrides it via `Effect.provideService(Hooks, customHooks)`. Same
 * pattern as `Tracer.Tracer` (slice 25).
 *
 * This slice ships `onAgentEvent` only — a pure observer invoked once per
 * `AgentEvent` the stream emits (logging, UI updates, telemetry sinks). It
 * cannot mutate the event or the loop. Mutating hooks (block a tool call,
 * patch a tool result) and lifecycle hooks (`onStart` / `onShutdown`, per
 * ADR-0014) are deferred to later slices.
 */
import { Context, Effect } from "effect";

import type { AgentEvent } from "./agent-event.js";

export interface Hooks {
	/**
	 * Invoked once per `AgentEvent` the `Session.send` stream emits, in stream
	 * order (including prepended orchestration events like `CompactionApplied`).
	 * Observer-only — the returned Effect's value is discarded and it cannot
	 * change the event or the loop.
	 */
	readonly onAgentEvent: (event: AgentEvent) => Effect.Effect<void>;
}

/**
 * The `Hooks` service. Default is a no-op `onAgentEvent`; provide a custom
 * implementation with `Effect.provideService(Hooks, ...)`.
 */
export const Hooks: Context.Reference<Hooks> = Context.Reference<Hooks>("pi/Hooks", {
	defaultValue: (): Hooks => ({ onAgentEvent: () => Effect.void }),
});
