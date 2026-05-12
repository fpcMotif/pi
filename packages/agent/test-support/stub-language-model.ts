import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";

export interface StubLanguageModelOptions {
	readonly text: string;
}

export const stubLanguageModel = (options: StubLanguageModelOptions) =>
	Layer.succeed(
		LanguageModel.LanguageModel,
		LanguageModel.LanguageModel.of({
			generateText: ((_options: unknown) =>
				Effect.succeed(
					new LanguageModel.GenerateTextResponse([Response.makePart("text", { text: options.text })]),
				)) as never,
			generateObject: (() => Effect.die("stub: generateObject not implemented")) as never,
			streamText: (() => Stream.empty) as never,
		}),
	);
