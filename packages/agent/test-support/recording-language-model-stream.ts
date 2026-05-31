import { Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";

import { dieUnimplemented } from "./die-unimplemented.js";

export interface RecordingLanguageModelStream {
	/** Layer providing the recording `LanguageModel`. */
	readonly layer: Layer.Layer<LanguageModel.LanguageModel>;
	/** Every options object `streamText` was called with, in call order. */
	readonly calls: ReadonlyArray<Record<string, unknown>>;
}

/**
 * A Layer providing {@link LanguageModel.LanguageModel} whose `streamText`
 * yields a caller-supplied canned part sequence AND records the options object
 * it was invoked with into a shared `calls` array.
 *
 * Use when the test asserts on what `Session.send` *passes* to `streamText`
 * (e.g. the `concurrency` knob) rather than on the events it produces.
 * `generateText` / `generateObject` die on call.
 */
export const recordingLanguageModelStream = (parts: ReadonlyArray<unknown>): RecordingLanguageModelStream => {
	const calls: Array<Record<string, unknown>> = [];
	const layer = Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: dieUnimplemented("recordingLanguageModelStream", "generateText"),
			generateObject: dieUnimplemented("recordingLanguageModelStream", "generateObject"),
			streamText: ((options: Record<string, unknown>) => {
				calls.push(options);
				return Stream.fromIterable(parts);
			}) as never,
		}),
	);
	return { layer, calls };
};
