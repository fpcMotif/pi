import { Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel, Response } from "effect/unstable/ai";

import { dieUnimplemented } from "./die-unimplemented.js";

export interface StubLanguageModelDualOptions {
	/** Canned text returned by `generateText` (the compaction summary call). */
	readonly summaryText?: string;
	/** When set, `generateText` fails with this `AiError` instead of returning text. */
	readonly summaryError?: AiError.AiError;
	/**
	 * When set, every `generateText` call awaits this Effect before returning —
	 * lets a test hold the compaction summary call "in flight" while it drives
	 * other concurrent work.
	 */
	readonly summaryLatch?: Effect.Effect<void>;
	/** Canned `Response.StreamPart`-shaped sequence returned by `streamText`. */
	readonly streamParts: ReadonlyArray<unknown>;
}

/**
 * A Layer providing {@link LanguageModel.LanguageModel} that answers BOTH
 * `generateText` (with a canned text response, or a canned `AiError` failure)
 * AND `streamText` (with a canned part sequence), bypassing the provider layer
 * entirely.
 *
 * Needed by `Session.send` compaction tests: a single `send` first calls
 * `generateText` to summarise the older history, then `streamText` for the
 * actual turn — so the test runtime must satisfy both methods. The existing
 * single-purpose stubs (`stubLanguageModel`, `stubLanguageModelStream`) each
 * die on the other method.
 */
export const stubLanguageModelDual = (options: StubLanguageModelDualOptions) =>
	Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: ((_options: unknown) =>
				Effect.gen(function* () {
					if (options.summaryLatch !== undefined) {
						yield* options.summaryLatch;
					}
					if (options.summaryError !== undefined) {
						return yield* Effect.fail(options.summaryError);
					}
					return new LanguageModel.GenerateTextResponse([
						Response.makePart("text", { text: options.summaryText ?? "" }),
					]);
				})) as never,
			generateObject: dieUnimplemented("stubLanguageModelDual", "generateObject"),
			streamText: (() => Stream.fromIterable(options.streamParts)) as never,
		}),
	);
