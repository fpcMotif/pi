/**
 * Tracer bullet for transient-error retry (slice 24).
 *
 * Behavior:
 *
 * - When the upstream `LanguageModel.streamText` fails with an `AiError` whose
 *   `reason.isRetryable === true` (e.g. `RateLimitError`, `OverloadedError`,
 *   `TransportError`), `Session.send` retries the per-attempt inner stream up
 *   to `MAX_LLM_RETRIES = 3` times before propagating the error.
 * - When the upstream fails with a non-retryable `AiError` (e.g.
 *   `AuthenticationError`, `InvalidRequestError`, `ContentPolicyError`), the
 *   error propagates immediately after the first attempt — no retries.
 * - On a successful retry, the consumer sees only the successful attempt's
 *   events (no leakage from failed attempts because each attempt re-creates
 *   the accumulator Refs).
 * - History + turnCount are bumped ONCE per `send` (not once per attempt) —
 *   they sit outside the retry boundary.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { AiError } from "effect/unstable/ai";
import { describe, expect } from "vitest";
import { LlmError } from "../../effect/agent-error.js";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStreamScripted } from "../../test-support/stub-language-model-stream-scripted.js";

const rateLimit = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.RateLimitError({}),
});

const auth = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
});

const finishPart = (input: number, output: number) => ({
	type: "finish" as const,
	reason: "stop" as const,
	usage: {
		inputTokens: { uncached: undefined, total: input, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: output, text: undefined, reasoning: undefined },
	},
	response: undefined,
});

function expectLlmError(err: unknown): LlmError {
	expect(err).toBeInstanceOf(LlmError);
	if (!(err instanceof LlmError)) {
		throw new Error(`Expected LlmError, got ${String(err)}`);
	}
	return err;
}

describe("Session.send retries on retryable AiError reasons, propagates non-retryable ones", () => {
	it.effect("two RateLimitError attempts then a successful attempt → events flow, turnCount bumps once", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hello"));

			// Consumer sees ONLY the successful attempt's events. The two failed
			// attempts never emitted any LlmPart because the stub fails at-open.
			const tags = events.map((e) => e._tag);
			expect(tags).toEqual(["LlmPart", "LlmPart", "Finish"]);

			// State reflects exactly one send: turnCount=1, one user + one assistant msg.
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user", "assistant"]);

			// Token totals came from the successful attempt's finish part.
			expect(snapshot.inputTokens).toBe(7);
			expect(snapshot.outputTokens).toBe(11);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
					{ type: "parts", parts: [{ type: "text-delta", id: "msg_1", delta: "ok" }, finishPart(7, 11)] },
				]),
			),
		),
	);

	it.effect("AuthenticationError (non-retryable) propagates immediately — no retries", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			// Stream fails — Effect.flip turns the failure success so we can inspect it.
			const err = yield* Effect.flip(Stream.runDrain(session.send("hello")));
			const llmError = expectLlmError(err);
			expect((llmError.aiError as { readonly reason: { readonly _tag: string } }).reason._tag).toBe(
				"AuthenticationError",
			);

			// turnCount + user message landed (pre-stream, runs once). No assistant message
			// because the upstream failed before any events flowed.
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user"]);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					// Only ONE error step — if a retry fires we'd hit the script's end-die path.
					{ type: "error", error: auth },
				]),
			),
		),
	);

	it.effect("retry cap exceeded (4 retryable failures) → last error propagates", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const err = yield* Effect.flip(Stream.runDrain(session.send("hello")));

			const llmError = expectLlmError(err);
			expect((llmError.aiError as { readonly reason: { readonly _tag: string } }).reason._tag).toBe(
				"RateLimitError",
			);

			// Despite 4 attempts, state shows just the once-per-send pre-stream effects.
			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content.map((m) => m.role)).toEqual(["user"]);
			expect(snapshot.inputTokens).toBe(0);
			expect(snapshot.outputTokens).toBe(0);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					// 4 retryable failures — initial attempt + 3 retries = 4 total tries.
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
					{ type: "error", error: rateLimit },
				]),
			),
		),
	);
});
