/**
 * Tracer bullet for `Effect.withSpan` telemetry on `Session.send` (slice 25).
 *
 * Behavior:
 *
 * - Each `Session.send` call emits one outer span `pi.Session.send` with
 *   attributes `pi.input.tag` (the discriminated-union variant) and
 *   `pi.history.size` (number of messages in history at send time).
 * - The send body wraps the per-attempt pipeline in
 *   `pi.Session.send.attempt` with attribute `pi.attempt.number`.
 *   - One attempt span per try: a clean send → 1 attempt span; a retry
 *     sequence with 2 transient failures + 1 success → 3 sibling attempt
 *     spans (numbered 1, 2, 3) all under the same `pi.Session.send` parent.
 * - On send completion the spans transition `status._tag` from `"Started"`
 *   to `"Ended"` (via `NativeSpan.end`), with the exit attached. Tests can
 *   distinguish successful attempts from failed ones by reading
 *   `span.status.exit._tag`.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, Tracer } from "effect";
import { AiError } from "effect/unstable/ai";
import { describe, expect } from "vitest";
import { Session } from "../../effect/session.js";
import { recordingTracer } from "../../test-support/recording-tracer.js";
import { stubLanguageModelStreamScripted } from "../../test-support/stub-language-model-stream-scripted.js";

const rateLimit = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.RateLimitError({}),
});

const okParts = [
	{ type: "text-delta" as const, id: "msg_1", delta: "hi" },
	{
		type: "finish" as const,
		reason: "stop" as const,
		usage: {
			inputTokens: { uncached: undefined, total: 3, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 5, text: undefined, reasoning: undefined },
		},
		response: undefined,
	},
];

describe("Session.send emits Effect.withSpan telemetry on send + per attempt", () => {
	it.effect("one clean send → exactly 1 outer span and 1 attempt span; attributes wired", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const { tracer, spans } = recordingTracer();

			yield* Stream.runDrain(session.send("hello")).pipe(Effect.provideService(Tracer.Tracer, tracer));

			const names = spans.map((s) => s.name);
			// Parent first (the outer `pi.Session.send` span opens before the inner
			// `pi.Session.send.attempt` span — `Stream.withSpan` start order mirrors
			// the pipe nesting).
			expect(names).toEqual(["pi.Session.send", "pi.Session.send.attempt"]);

			const sendSpan = spans.find((s) => s.name === "pi.Session.send");
			expect(sendSpan?.attributes.get("pi.input.tag")).toBe("NewPrompt");
			expect(sendSpan?.attributes.get("pi.history.size")).toBe(1);

			const attemptSpan = spans.find((s) => s.name === "pi.Session.send.attempt");
			expect(attemptSpan?.attributes.get("pi.attempt.number")).toBe(1);

			// Both spans ended successfully.
			expect(sendSpan?.status._tag).toBe("Ended");
			expect(attemptSpan?.status._tag).toBe("Ended");
		}).pipe(Effect.provide(stubLanguageModelStreamScripted([{ type: "parts", parts: okParts }]))),
	);

	it.effect("retry-then-success → 3 attempt spans (numbered 1, 2, 3) + 1 send span; all end as expected", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const { tracer, spans } = recordingTracer();

			yield* Stream.runDrain(session.send("hello")).pipe(Effect.provideService(Tracer.Tracer, tracer));

			const attemptSpans = spans.filter((s) => s.name === "pi.Session.send.attempt");
			expect(attemptSpans).toHaveLength(3);
			expect(attemptSpans.map((s) => s.attributes.get("pi.attempt.number"))).toEqual([1, 2, 3]);

			const sendSpans = spans.filter((s) => s.name === "pi.Session.send");
			expect(sendSpans).toHaveLength(1);

			// Every span ended; the send span ended in success (the third attempt succeeded).
			expect(spans.every((s) => s.status._tag === "Ended")).toBe(true);
			const sendStatus = sendSpans[0]!.status;
			if (sendStatus._tag === "Ended") {
				expect(sendStatus.exit._tag).toBe("Success");
			}
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
					{ type: "parts", parts: okParts },
				]),
			),
		),
	);
});
