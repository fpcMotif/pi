import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClientStreaming } from "../../test-support/stub-openai-client-streaming.js";

describe("Streaming (LanguageModel.streamText via stub createResponseStream)", () => {
	it.effect("text-delta parts collected from the stream reconstruct the canned text", () =>
		Effect.gen(function* () {
			const stream = LanguageModel.streamText({ prompt: "say hi" });
			// In v4, Stream.runCollect returns Effect<Array<A>>, not Effect<Chunk<A>>.
			const parts = yield* Stream.runCollect(stream);

			const deltas = parts
				.filter((p): p is Extract<typeof p, { readonly type: "text-delta" }> => p.type === "text-delta")
				.map((p) => p.delta);

			expect(deltas.join("")).toBe("Hello, streaming world!");

			// At least one text-delta part and one finish part.
			expect(deltas.length).toBeGreaterThan(0);
			expect(parts.some((p) => p.type === "finish")).toBe(true);
		}).pipe(
			Effect.provide(
				OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
					Layer.provide(
						stubOpenAiClientStreaming({
							text: "Hello, streaming world!",
							chunkCount: 4,
						}),
					),
				),
			),
		),
	);
});
