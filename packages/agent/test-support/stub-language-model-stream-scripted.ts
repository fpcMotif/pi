import { Effect, Layer, Stream } from "effect";
import type { AiError } from "effect/unstable/ai";
import { LanguageModel } from "effect/unstable/ai";

import { makeScriptedCursor } from "./scripted-cursor.js";

/**
 * One step in a scripted streaming session. A `parts` step has the stream emit
 * the canned `Response.StreamPart`-shaped sequence on that call; an `error`
 * step has the stream fail with the given `AiError` (this surfaces in the
 * `streamText` error channel before any elements flow).
 */
export type StubStreamStep =
	| { readonly type: "parts"; readonly parts: ReadonlyArray<unknown> }
	| { readonly type: "error"; readonly error: AiError.AiError };

/**
 * A Layer providing {@link LanguageModel.LanguageModel} whose `streamText`
 * consumes a scripted sequence of steps — one stream of parts (or one
 * fail-at-open error) per call, in order.
 *
 * Useful for tests that need to drive `Session.send` through a failure →
 * success retry sequence (e.g. transient `RateLimitError` on calls 1-2 then a
 * successful stream on call 3), or any other test where the second call's
 * stream differs from the first's.
 *
 * Calls beyond the script length die loudly so accidental extra calls (e.g. a
 * runaway retry loop) are visible in test output.
 *
 * Bypasses the OpenAI provider layer entirely (mirrors
 * `stubLanguageModelStream` — same shape, scripted across calls).
 */
export const stubLanguageModelStreamScripted = (script: ReadonlyArray<StubStreamStep>) =>
	Layer.effect(LanguageModel.LanguageModel)(
		Effect.gen(function* () {
			const cursor = yield* makeScriptedCursor;
			return LanguageModel.LanguageModel.of({
				generateText: (() => Effect.die("stubLanguageModelStreamScripted: generateText not implemented")) as never,
				generateObject: (() =>
					Effect.die("stubLanguageModelStreamScripted: generateObject not implemented")) as never,
				streamText: ((..._args: ReadonlyArray<unknown>) => {
					// Pull the call index synchronously off the Ref inside the stream so each
					// invocation of `streamText` consumes exactly one step. The stream factory
					// itself is pure; the Ref read is what advances the script.
					return Stream.unwrap(
						Effect.gen(function* () {
							const i = yield* cursor.next;
							const step = script[i];
							if (!step) {
								return Stream.die(
									`stubLanguageModelStreamScripted: no scripted response for call ${i} (script length: ${script.length})`,
								);
							}
							if (step.type === "error") {
								return Stream.fail(step.error);
							}
							return Stream.fromIterable(step.parts);
						}),
					);
				}) as never,
			});
		}),
	);
