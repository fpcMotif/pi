import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";

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
export const stubLanguageModelStream = (parts: ReadonlyArray<Response.StreamPartEncoded>) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({
			generateText: () => Effect.die("stubLanguageModelStream: generateText not implemented"),
			streamText: () => Stream.fromIterable(parts),
		}),
	);
