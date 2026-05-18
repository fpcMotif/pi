import { Effect, Ref, Stream, SubscriptionRef, type Types } from "effect";
import { LanguageModel, Prompt, type Tool } from "effect/unstable/ai";

import { LlmError } from "./agent-error.js";
import { type AgentEvent, Finish } from "./agent-event.js";
import { type AssistantContentAcc, accumulatePart, finalize, initialAcc } from "./history-accumulator.js";
import { liftPart } from "./lift-part.js";
import { SessionState } from "./session-state.js";
import { type CapturedUsage, captureUsage } from "./token-capture.js";

/**
 * Build the per-attempt stream for one `Session.send` try. Fresh `accRef` and
 * `usageRef` per attempt so a `Stream.retry` re-open produces a clean
 * accumulator (no leakage from partial events of a failed attempt).
 *
 * Pipeline (in order):
 *   - `LanguageModel.streamText` opens the upstream with the snapshot history.
 *   - `Stream.flatMap(liftPart)` lifts each `Response.AnyPart` to one or more
 *     `AgentEvent`s (raw `LlmPart` plus orchestration events).
 *   - `Stream.tap` accumulates `LlmPart`s into the assistant-content acc and
 *     peels token totals off the upstream `finish` part.
 *   - `Stream.mapError` wraps upstream `AiError`s into pi `LlmError` BEFORE
 *     the retry boundary, so the schedule's predicate reads `LlmError`.
 *   - `Stream.concat` appends the final assistant message to history and
 *     emits a trailing `Finish` event with this attempt's tokens.
 *   - `Stream.withSpan("pi.Session.send.attempt", { attempt.number })` wraps
 *     the whole attempt pipeline; the span ends when the attempt completes
 *     (success / failure / interrupt) and re-opens fresh on each retry.
 */
export const makeAttemptStream = <Tools extends Record<string, Tool.Any>>(params: {
	readonly state: SubscriptionRef.SubscriptionRef<SessionState>;
	readonly snapshot: SessionState;
	readonly attemptCounter: Ref.Ref<number>;
	readonly toolkit: LanguageModel.ToolkitInput<Tools> | undefined;
	readonly concurrency: Types.Concurrency;
}): Stream.Stream<AgentEvent, LlmError, LanguageModel.LanguageModel> => {
	const { state, snapshot, attemptCounter, toolkit, concurrency } = params;
	return Stream.unwrap(
		Effect.gen(function* () {
			// Bump the attempt counter and capture the value for this attempt's span.
			const attemptNumber = yield* Ref.updateAndGet(attemptCounter, (n) => n + 1);

			// Accumulator for the assistant's response — text deltas, tool calls,
			// and tool results in arrival order. Streaming-only artifacts skipped.
			const accRef = yield* Ref.make<AssistantContentAcc>(initialAcc);

			// Per-attempt usage capture. Stays null until a `finish` part lands;
			// if the attempt ends without one (errored / interrupted upstream),
			// the trailing `Finish` event omits token fields and state totals
			// don't bump.
			const usageRef = yield* Ref.make<CapturedUsage | null>(null);

			// Open the upstream stream with the FULL history (incl. just-appended user msg).
			// `concurrency` controls tool-call resolution parallelism (sequential
			// by default per ADR-0009; see `resolvedConcurrency` above).
			// `as never` bypasses the streamText overload-picker, which can't see through
			// the conditional spread at the type level. Runtime path is identical.
			const upstream =
				toolkit === undefined
					? LanguageModel.streamText({
							prompt: snapshot.history,
							concurrency,
						})
					: (LanguageModel.streamText({
							prompt: snapshot.history,
							toolkit,
							concurrency,
						} as never) as Stream.Stream<unknown, unknown, LanguageModel.LanguageModel>);

			return upstream.pipe(
				Stream.flatMap((part) => Stream.fromIterable(liftPart(part))),
				// Absorb each LlmPart into the assistant-content accumulator. Skips
				// streaming-only artifacts; coalesces text deltas; captures tool turns.
				// Also peels usage totals off the upstream `finish` part into usageRef.
				Stream.tap((event) =>
					event._tag === "LlmPart"
						? Effect.gen(function* () {
								yield* Ref.update(accRef, (acc) => accumulatePart(acc, event.part));
								const captured = captureUsage(event.part);
								if (captured !== null) {
									yield* Ref.set(usageRef, captured);
								}
							})
						: Effect.void,
				),
				// Map BEFORE the retry boundary so the schedule's predicate sees `LlmError`.
				Stream.mapError((aiError): LlmError => new LlmError({ aiError })),
				// After the upstream completes, append the assistant message (with
				// text + tool-call + tool-result content in order), bump cumulative
				// token totals on state, and emit Finish carrying this send's tokens.
				// On a failed attempt this concat never runs (Stream.concat skips
				// when the left side errors), so partial accumulator state never
				// leaks into `state.history`.
				Stream.concat(
					Stream.unwrap(
						Effect.gen(function* () {
							const acc = yield* Ref.get(accRef);
							const content = finalize(acc);
							const usage = yield* Ref.get(usageRef);
							if (content.length > 0 || usage !== null) {
								yield* SubscriptionRef.update(state, (s) => {
									const nextHistory =
										content.length > 0
											? Prompt.concat(s.history, Prompt.make([{ role: "assistant", content }] as never))
											: s.history;
									return SessionState.with(s, {
										history: nextHistory,
										inputTokens: s.inputTokens + (usage?.inputTokens ?? 0),
										outputTokens: s.outputTokens + (usage?.outputTokens ?? 0),
									});
								});
							}
							return Stream.succeed<AgentEvent>(
								usage === null
									? new Finish({})
									: new Finish({
											inputTokens: usage.inputTokens,
											outputTokens: usage.outputTokens,
										}),
							);
						}),
					),
				),
				// Per-attempt telemetry span. Wraps the entire attempt pipeline:
				// flatMap + tap + mapError + concat. The span ends when the attempt
				// completes (success / any failure / interruption). On retry, a new
				// attemptStream open re-enters this Effect.gen, bumps the counter,
				// and emits a fresh sibling span under the outer `pi.Session.send`
				// span — so consumers see one attempt span per try.
				Stream.withSpan("pi.Session.send.attempt", {
					attributes: { "pi.attempt.number": attemptNumber },
				}),
			);
		}),
	);
};
