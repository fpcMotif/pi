import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";

export interface StubLanguageModelOptions {
	readonly text: string;
}

const textPart = (text: string): Response.TextPartEncoded => ({ type: "text", text });

export const stubLanguageModel = (options: StubLanguageModelOptions) =>
	Layer.effect(
		LanguageModel.LanguageModel,
		LanguageModel.make({
			generateText: () => Effect.succeed([textPart(options.text)]),
			streamText: () => Stream.empty,
		}),
	);
