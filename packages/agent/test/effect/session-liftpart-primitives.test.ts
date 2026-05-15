import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import type { AgentEvent, LlmPart } from "../../effect/agent-event.js";
import { Session } from "../../effect/session.js";

/**
 * Slice (covering `effect/session.ts:liftPart` defensive guard) -- the
 * `!isRecord(part)` early return is unreachable in normal operation because
 * `LanguageModel.streamText` validates upstream parts against
 * `Response.StreamPart` (always non-null objects). The guard nonetheless lives
 * in the source for defence-in-depth, and the v8 branch coverage gate needs
 * to see both arms exercised.
 *
 * These tests bypass the validation pipeline by constructing the
 * `LanguageModel.LanguageModel` Service directly via `Layer.succeed` + `.of`,
 * feeding primitives / `null` / unrecognised objects straight into the
 * `Session.send` Stream.
 */
const directStubLanguageModelStream = (parts: ReadonlyArray<unknown>) =>
	Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: (() => Effect.die("directStub: generateText not implemented")) as never,
			generateObject: (() => Effect.die("directStub: generateObject not implemented")) as never,
			streamText: (() => Stream.fromIterable(parts)) as never,
		}),
	);

const firstLlmPart = (events: ReadonlyArray<AgentEvent>): unknown => {
	const event = events[0];
	if (event?._tag !== "LlmPart") {
		throw new Error("expected first event to be LlmPart");
	}
	return (event as LlmPart).part;
};

describe("Session.send liftPart -- defensive guard against non-record stream parts", () => {
	it.effect("a string part passes through as a single LlmPart followed by Finish", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("..."));

			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "Finish"]);
			expect(firstLlmPart(events)).toBe("primitive-string-part");
		}).pipe(Effect.provide(directStubLanguageModelStream(["primitive-string-part"]))),
	);

	it.effect("a numeric part passes through as a single LlmPart", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("..."));

			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "Finish"]);
			expect(firstLlmPart(events)).toBe(42);
		}).pipe(Effect.provide(directStubLanguageModelStream([42]))),
	);

	it.effect("a null part passes through as a single LlmPart", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("..."));

			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "Finish"]);
			expect(firstLlmPart(events)).toBeNull();
		}).pipe(Effect.provide(directStubLanguageModelStream([null]))),
	);

	it.effect("an object with no recognised type tag passes through as a single LlmPart", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("..."));

			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "Finish"]);
			expect(firstLlmPart(events)).toEqual({ type: "not-a-known-tag", payload: 1 });
		}).pipe(Effect.provide(directStubLanguageModelStream([{ type: "not-a-known-tag", payload: 1 }]))),
	);

	it.effect("a tool-call object missing string id/name falls through to base LlmPart only", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("..."));

			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "Finish"]);
		}).pipe(Effect.provide(directStubLanguageModelStream([{ type: "tool-call" }]))),
	);

	it.effect("a tool-result object missing isFailure boolean falls through to base LlmPart only", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("..."));

			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "Finish"]);
		}).pipe(
			Effect.provide(
				directStubLanguageModelStream([{ type: "tool-result", id: "call_x", name: "ToolX", result: { ok: true } }]),
			),
		),
	);
});
