import { Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";

import { notImplemented } from "./_not-implemented.js";

const OWNER = "stubLanguageModelStream";

/**
 * A Layer providing {@link LanguageModel.LanguageModel} with a `streamText`
 * that yields a caller-supplied sequence of `Response.StreamPart`-shaped
 * objects, bypassing the provider (OpenAI / OpenRouter / …) layer entirely.
 *
 * Useful for tests that need to drive `Session.send` (or any other consumer
 * of `LanguageModel.streamText`) through a precise, deterministic part
 * sequence — e.g. asserting how the consumer lifts `tool-call` / `tool-result`
 * parts into higher-level events.
 *
 * `generateText` / `generateObject` die on call; pair only with code paths
 * that exercise `streamText`.
 */
export const stubLanguageModelStream = (parts: ReadonlyArray<unknown>) =>
	Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: (() => notImplemented(OWNER, "generateText")) as never,
			generateObject: (() => notImplemented(OWNER, "generateObject")) as never,
			streamText: (() => Stream.fromIterable(parts)) as never,
		}),
	);
