import { Effect, Ref } from "effect";

/**
 * Cursor-advancing helper shared by `stubOpenAiClientScripted` and
 * `stubLanguageModelStreamScripted`. Reads (and post-bumps) the call index,
 * looks up the next scripted step, and dies loudly when the script is
 * exhausted so accidental extra calls (e.g. a runaway retry loop) are visible
 * in test output.
 *
 * Callers wrap the returned step in whatever shape they need (an Effect for
 * single-shot stubs, a Stream for streaming stubs) — this helper stays
 * payload-agnostic.
 */
export const advanceScript = <S>(
	callIndex: Ref.Ref<number>,
	script: ReadonlyArray<S>,
	fixtureName: string,
): Effect.Effect<{ readonly step: S; readonly index: number }> =>
	Effect.gen(function* () {
		const index = yield* Ref.getAndUpdate(callIndex, (n) => n + 1);
		const step = script[index];
		if (!step) {
			return yield* Effect.die(
				`${fixtureName}: no scripted response for call ${index} (script length: ${script.length})`,
			);
		}
		return { step, index };
	});
