/**
 * Tracer bullet for token / cost accounting (slice 23).
 *
 * Behavior:
 *
 * - When the upstream stream emits a `type: "finish"` part with usage
 *   information, `Session.send` captures `usage.inputTokens.total` and
 *   `usage.outputTokens.total` and:
 *   1. Emits a trailing `Finish` event carrying both values.
 *   2. Bumps `state.inputTokens` / `state.outputTokens` cumulatively.
 * - Across multiple `send` calls, the totals accumulate (each send's usage is
 *   added on top of the prior totals).
 * - When the upstream stream omits a `finish` part entirely, the trailing
 *   `Finish` event has both token fields undefined and the state totals stay
 *   put (no accidental zero-overwrite, no NaN propagation).
 * - Undefined `usage.{input,output}Tokens.total` values fall through as 0
 *   (the upstream schema permits them — providers don't always populate
 *   every field).
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";
import type { Finish } from "../../effect/agent-event.js";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

const finishPart = (inputTotal: number | undefined, outputTotal: number | undefined) => ({
	type: "finish" as const,
	reason: "stop" as const,
	usage: {
		inputTokens: {
			uncached: undefined,
			total: inputTotal,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: outputTotal,
			text: undefined,
			reasoning: undefined,
		},
	},
	response: undefined,
});

describe("Session.send captures token usage from upstream finish parts", () => {
	it.effect("Finish event carries inputTokens + outputTokens and state accumulates them", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hello"));

			const finish = events.find((e) => e._tag === "Finish") as Finish | undefined;
			expect(finish).toBeDefined();
			expect(finish?.inputTokens).toBe(10);
			expect(finish?.outputTokens).toBe(25);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.inputTokens).toBe(10);
			expect(snapshot.outputTokens).toBe(25);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([{ type: "text-delta", id: "msg_1", delta: "Hi back" }, finishPart(10, 25)]),
			),
		),
	);

	it.effect("totals accumulate across multiple sends", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("first"));
			yield* Stream.runDrain(session.send("second"));

			const snapshot = yield* SubscriptionRef.get(session.state);
			// Same stub layer fires for both sends → 10 + 10 input, 25 + 25 output.
			expect(snapshot.inputTokens).toBe(20);
			expect(snapshot.outputTokens).toBe(50);
			expect(snapshot.turnCount).toBe(2);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([{ type: "text-delta", id: "msg_1", delta: "ok" }, finishPart(10, 25)]),
			),
		),
	);

	it.effect("undefined usage totals fall through as 0 (Finish carries 0, state unchanged from 0)", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hi"));

			const finish = events.find((e) => e._tag === "Finish") as Finish | undefined;
			expect(finish?.inputTokens).toBe(0);
			expect(finish?.outputTokens).toBe(0);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.inputTokens).toBe(0);
			expect(snapshot.outputTokens).toBe(0);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{ type: "text-delta", id: "msg_1", delta: "hi" },
					finishPart(undefined, undefined),
				]),
			),
		),
	);

	it.effect("non-record finish usage is treated as zero usage", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hello"));

			const finish = events.find((e) => e._tag === "Finish") as Finish | undefined;
			expect(finish?.inputTokens).toBe(0);
			expect(finish?.outputTokens).toBe(0);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.inputTokens).toBe(0);
			expect(snapshot.outputTokens).toBe(0);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					{
						type: "finish",
						reason: "stop",
						usage: "not-a-usage-object",
						response: undefined,
					},
				]),
			),
		),
	);

	it.effect("finish-only streams update usage totals without appending an empty assistant message", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hello"));

			const finish = events.find((e) => e._tag === "Finish") as Finish | undefined;
			expect(finish?.inputTokens).toBe(3);
			expect(finish?.outputTokens).toBe(4);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user"]);
			expect(snapshot.inputTokens).toBe(3);
			expect(snapshot.outputTokens).toBe(4);
		}).pipe(Effect.provide(stubLanguageModelStream([finishPart(3, 4)]))),
	);

	it.effect("when upstream omits a finish part, Finish has no token fields and state totals stay put", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hello"));

			const finish = events.find((e) => e._tag === "Finish") as Finish | undefined;
			expect(finish).toBeDefined();
			expect(finish?.inputTokens).toBeUndefined();
			expect(finish?.outputTokens).toBeUndefined();

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.inputTokens).toBe(0);
			expect(snapshot.outputTokens).toBe(0);
		}).pipe(Effect.provide(stubLanguageModelStream([{ type: "text-delta", id: "msg_1", delta: "no finish here" }]))),
	);
});
