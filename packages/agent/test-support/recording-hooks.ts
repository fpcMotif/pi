import { Effect, type Exit } from "effect";

import type { AgentError } from "../effect/agent-error.js";
import type { AgentEvent } from "../effect/agent-event.js";
import type { Input } from "../effect/agent-input.js";
import type { Hooks } from "../effect/hooks.js";

/**
 * Build an in-memory {@link Hooks} that records every observer invocation it
 * receives. Combined with `Effect.provideService(Hooks, hooks)`, tests can
 * assert that `Session.send` invoked each hook the expected number of times.
 *
 * - `events` — every `AgentEvent` `onAgentEvent` observed, in stream order.
 * - `startInputs` — every normalised `Input` `onStart` received, in call order
 *   across multiple sends (one entry per `send` call).
 * - `shutdownExits` — every `Exit` `onShutdown` received, one per `send` call.
 *   Use `.length` for the count, `.exits[i]._tag` for success / failure, and
 *   `Exit.match` for richer assertions.
 *
 * @example
 * ```ts
 * const recording = recordingHooks()
 * const emitted = yield* Stream.runCollect(session.send("hi")).pipe(
 *   Effect.provideService(Hooks, recording.hooks)
 * )
 * expect(recording.events.map(e => e._tag)).toEqual(emitted.map(e => e._tag))
 * expect(recording.startInputs[0]._tag).toBe("NewPrompt")
 * expect(recording.shutdownExits).toHaveLength(1)
 * expect(recording.shutdownExits[0]._tag).toBe("Success")
 * ```
 */
export const recordingHooks = (): {
	readonly hooks: Hooks;
	readonly events: ReadonlyArray<AgentEvent>;
	readonly startInputs: ReadonlyArray<Input>;
	readonly shutdownExits: ReadonlyArray<Exit.Exit<unknown, AgentError>>;
} => {
	const events: Array<AgentEvent> = [];
	const startInputs: Array<Input> = [];
	const shutdownExits: Array<Exit.Exit<unknown, AgentError>> = [];
	const hooks: Hooks = {
		onAgentEvent: (event) =>
			Effect.sync(() => {
				events.push(event);
			}),
		onStart: (input) =>
			Effect.sync(() => {
				startInputs.push(input);
			}),
		onShutdown: (exit) =>
			Effect.sync(() => {
				shutdownExits.push(exit);
			}),
	};
	return { hooks, events, startInputs, shutdownExits };
};
