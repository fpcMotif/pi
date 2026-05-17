/**
 * Tracer bullet for the lifecycle-hooks composition adapter (slice 39).
 *
 * `composeHooks(...hooks)` fans every observer call out to multiple `Hooks`
 * implementations in sequence — the host-lifecycle composition primitive
 * called out in ADR-0014. Each composed hook gets every event / start / exit
 * the loop produces, so a host can wire logging, telemetry, and UI sinks side
 * by side without a custom dispatcher.
 *
 * Defects (`Effect.die`, unchecked throws) inside an underlying hook are
 * absorbed by `composeHooks` (via `Effect.catchAllCause`) and logged at
 * warning level; subsequent hooks for that same event STILL run, and the
 * loop completes normally. This isolates observer bugs from the loop so a
 * buggy hook cannot leave a durable session in a partial-turn state — see
 * ADR-0018 for the design evolution.
 */
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import { composeHooks, Hooks } from "../../effect/hooks.js";
import { Session } from "../../effect/session.js";
import { recordingHooks } from "../../test-support/recording-hooks.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

const parts = [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "answer" },
	{ type: "text-end", id: "t1" },
];

describe("composeHooks — lifecycle-hooks composition adapter", () => {
	it.effect("fans every onAgentEvent / onStart / onShutdown out to every composed hook", () =>
		Effect.gen(function* () {
			const first = recordingHooks();
			const second = recordingHooks();
			const composed = composeHooks(first.hooks, second.hooks);

			const session = yield* Session.empty;
			const emitted = yield* Stream.runCollect(session.send("hello")).pipe(Effect.provideService(Hooks, composed));

			// Both sinks saw every event the consumer saw, in stream order.
			expect(first.events.map((e) => e._tag)).toEqual(emitted.map((e) => e._tag));
			expect(second.events.map((e) => e._tag)).toEqual(emitted.map((e) => e._tag));

			// Both sinks saw exactly one onStart with the normalised NewPrompt.
			expect(first.startInputs).toHaveLength(1);
			expect(second.startInputs).toHaveLength(1);
			expect(first.startInputs[0]._tag).toBe("NewPrompt");
			expect(second.startInputs[0]._tag).toBe("NewPrompt");

			// Both sinks saw exactly one Success-shaped onShutdown.
			expect(first.shutdownExits).toHaveLength(1);
			expect(second.shutdownExits).toHaveLength(1);
			expect(first.shutdownExits[0]._tag).toBe("Success");
			expect(second.shutdownExits[0]._tag).toBe("Success");
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect("composeHooks() with zero hooks behaves like the no-op default", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			// Providing the empty composed hook proves the n=0 reduction is a no-op;
			// the stream completes normally and `R` does not gain a Hooks requirement.
			const emitted = yield* Stream.runCollect(session.send("hello")).pipe(
				Effect.provideService(Hooks, composeHooks()),
			);

			expect(emitted.length).toBeGreaterThan(0);
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect("composed hooks fire sequentially in the order they were passed", () =>
		Effect.gen(function* () {
			const order: Array<string> = [];
			const tag = (label: string): Hooks => ({
				onAgentEvent: () => Effect.sync(() => order.push(`${label}:event`)),
				onStart: () => Effect.sync(() => order.push(`${label}:start`)),
				onShutdown: () => Effect.sync(() => order.push(`${label}:shutdown`)),
			});
			const composed = composeHooks(tag("a"), tag("b"));
			const session = yield* Session.empty;

			yield* Stream.runDrain(session.send("hi")).pipe(Effect.provideService(Hooks, composed));

			// Start fans out a→b before any event; shutdown a→b at the end.
			const starts = order.filter((s) => s.endsWith(":start"));
			const shutdowns = order.filter((s) => s.endsWith(":shutdown"));
			expect(starts).toEqual(["a:start", "b:start"]);
			expect(shutdowns).toEqual(["a:shutdown", "b:shutdown"]);
			// Between start and shutdown, every event lands as `a:event` then `b:event`
			// (per-event, hooks fan a→b in order).
			const events = order.filter((s) => s.endsWith(":event"));
			for (let i = 0; i < events.length; i += 2) {
				expect(events[i].startsWith("a:")).toBe(true);
				expect(events[i + 1].startsWith("b:")).toBe(true);
			}
		}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect(
		"defect in one underlying hook is absorbed; subsequent hooks for that event still run; loop completes normally",
		() =>
			Effect.gen(function* () {
				// First hook dies on every onAgentEvent — composeHooks isolates the
				// defect via Effect.catchDefect and logs at warning level, so the
				// second hook still observes every event and the stream completes
				// normally. onStart / onShutdown are no-ops on the dying hook.
				const dyingFirst: Hooks = {
					onAgentEvent: () => Effect.die(new Error("boom")),
					onStart: () => Effect.void,
					onShutdown: () => Effect.void,
				};
				const second = recordingHooks();
				const composed = composeHooks(dyingFirst, second.hooks);
				const session = yield* Session.empty;

				const exit = yield* Effect.exit(
					Stream.runDrain(session.send("hi")).pipe(Effect.provideService(Hooks, composed)),
				);

				// Loop completes successfully despite the defect in the first hook.
				expect(exit._tag).toBe("Success");
				// onStart fanned a→b (neither hook dies on start).
				expect(second.startInputs).toHaveLength(1);
				// Defect-isolation: the second hook STILL sees every AgentEvent the
				// loop emitted (composeHooks absorbed the first hook's defect, did
				// not skip the second hook's invocation).
				expect(second.events.length).toBeGreaterThan(0);
				// `Stream.onExit`-backed onShutdown still fans through both.
				expect(second.shutdownExits).toHaveLength(1);
				expect(second.shutdownExits[0]._tag).toBe("Success");
			}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);

	it.effect(
		"synchronous throw in a hook method is isolated (Effect.suspend guard): second hook still observes; loop exits Success",
		() =>
			Effect.gen(function* () {
				// Codex adversarial review (ADR-0018 evolution): if `composeHooks`
				// only wraps the Effect *returned* by `h.onX(arg)`, a hook method
				// that `throw`s synchronously while constructing its Effect bypasses
				// `Effect.catchDefect` because the throw happens before the wrapper
				// runs. `composeHooks` therefore invokes each hook inside
				// `Effect.suspend(() => h.onX(arg))` so synchronous throws land as
				// defects inside the Effect runtime and are absorbed identically to
				// `Effect.die`-style defects. This test locks that protection.
				const throwingFirst: Hooks = {
					onAgentEvent: () => {
						throw new Error("synchronous boom");
					},
					onStart: () => Effect.void,
					onShutdown: () => Effect.void,
				};
				const second = recordingHooks();
				const composed = composeHooks(throwingFirst, second.hooks);
				const session = yield* Session.empty;

				const exit = yield* Effect.exit(
					Stream.runDrain(session.send("hi")).pipe(Effect.provideService(Hooks, composed)),
				);

				expect(exit._tag).toBe("Success");
				expect(second.startInputs).toHaveLength(1);
				expect(second.events.length).toBeGreaterThan(0);
				expect(second.shutdownExits).toHaveLength(1);
				expect(second.shutdownExits[0]._tag).toBe("Success");
			}).pipe(Effect.provide(stubLanguageModelStream(parts))),
	);
});
