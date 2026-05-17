import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";

import { notImplemented } from "./_not-implemented.js";

const OWNER = "recordingLanguageModelDual";

export interface RecordingLanguageModelDual {
	/** Layer providing the recording `LanguageModel`. */
	readonly layer: Layer.Layer<LanguageModel.LanguageModel>;
	/** Every options object `streamText` was called with, in call order. */
	readonly calls: ReadonlyArray<Record<string, unknown>>;
	/** Every options object `generateText` was called with, in call order. */
	readonly summaryCalls: ReadonlyArray<Record<string, unknown>>;
}

export interface RecordingLanguageModelDualOptions {
	/** Canned text returned by `generateText` (the compaction summary call). */
	readonly summaryText?: string;
	/** Canned `Response.StreamPart`-shaped sequence returned by `streamText`. */
	readonly streamParts: ReadonlyArray<unknown>;
}

/**
 * A Layer providing {@link LanguageModel.LanguageModel} that BOTH records every
 * `streamText` options object (like `recordingLanguageModelStream`) AND answers
 * `generateText` with canned summary text (like `stubLanguageModelDual`).
 *
 * Needed when a test must assert on the prompt `Session.send` passes to
 * `streamText` in a flow that ALSO triggers compaction (which calls
 * `generateText`) — e.g. the Retry-after-compaction ordering regression. The
 * `summaryCalls` array additionally records every `generateText` options
 * object so tests can assert on the summary call's prompt shape (e.g. the
 * structured-checkpoint instruction landing in the summarisation request).
 */
export const recordingLanguageModelDual = (options: RecordingLanguageModelDualOptions): RecordingLanguageModelDual => {
	const calls: Array<Record<string, unknown>> = [];
	const summaryCalls: Array<Record<string, unknown>> = [];
	const layer = Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: ((opts: Record<string, unknown>) => {
				summaryCalls.push(opts);
				return Effect.succeed(
					new LanguageModel.GenerateTextResponse([Response.makePart("text", { text: options.summaryText ?? "" })]),
				);
			}) as never,
			generateObject: (() => notImplemented(OWNER, "generateObject")) as never,
			streamText: ((opts: Record<string, unknown>) => {
				calls.push(opts);
				return Stream.fromIterable(options.streamParts);
			}) as never,
		}),
	);
	return { layer, calls, summaryCalls };
};
