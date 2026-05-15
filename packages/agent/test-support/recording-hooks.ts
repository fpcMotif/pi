import { Effect } from "effect";

import type { AgentEvent } from "../effect/agent-event.js";
import type { Hooks } from "../effect/hooks.js";

/**
 * Build an in-memory {@link Hooks} whose `onAgentEvent` pushes every observed
 * `AgentEvent` into a shared array. Combined with
 * `Effect.provideService(Hooks, hooks)`, tests can assert that `Session.send`
 * invoked the hook for every event it emitted, in order.
 *
 * @example
 * ```ts
 * const { hooks, events } = recordingHooks()
 * const emitted = yield* Stream.runCollect(session.send("hi")).pipe(
 *   Effect.provideService(Hooks, hooks)
 * )
 * expect(events.map(e => e._tag)).toEqual(emitted.map(e => e._tag))
 * ```
 */
export const recordingHooks = (): {
	readonly hooks: Hooks;
	readonly events: ReadonlyArray<AgentEvent>;
} => {
	const sink: Array<AgentEvent> = [];
	const hooks: Hooks = {
		onAgentEvent: (event) =>
			Effect.sync(() => {
				sink.push(event);
			}),
	};
	return { hooks, events: sink };
};
