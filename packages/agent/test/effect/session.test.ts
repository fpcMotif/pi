import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import type { LlmPart } from "../../effect/agent-event.js";
import { Session } from "../../effect/session.js";
import { openAiStreamingLayer } from "../../test-support/openai-language-model.js";

describe("Session (slice 12b/c — Session.empty + send wired to LanguageModel.streamText)", () => {
	it.effect("Session.empty resolves to a Session with a send function", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			expect(typeof session.send).toBe("function");
		}),
	);

	it.effect("send emits an LlmPart for each StreamPart and ends with a Finish", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hello"));

			// At least one event, last is Finish.
			expect(events.length).toBeGreaterThan(0);
			const last = events[events.length - 1];
			expect(last?._tag).toBe("Finish");

			// Every non-Finish event is an LlmPart (no tool events at this slice).
			const heads = events.slice(0, -1);
			expect(heads.length).toBeGreaterThan(0);
			expect(heads.every((e) => e._tag === "LlmPart")).toBe(true);

			// The wrapped parts include the text-delta items emitted by the stub.
			const textDeltas = heads
				.filter((e): e is LlmPart => e._tag === "LlmPart")
				.map((e) => e.part)
				.filter(
					(p): p is { readonly type: "text-delta"; readonly delta: string } =>
						typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text-delta",
				);
			expect(textDeltas.map((p) => p.delta).join("")).toBe("Hello from Session.send!");
		}).pipe(Effect.provide(openAiStreamingLayer("Hello from Session.send!", 3))),
	);
});
