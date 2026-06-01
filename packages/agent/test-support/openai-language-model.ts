import { OpenAiLanguageModel } from "@effect/ai-openai";
import { Layer } from "effect";
import { stubOpenAiClientStreaming } from "./stub-openai-client-streaming.js";

/**
 * Layer providing {@link LanguageModel.LanguageModel} via the OpenAI provider
 * wired against {@link stubOpenAiClientStreaming}. Streams `text` split into
 * `chunkCount` text-delta parts, terminated by a `finish` part.
 *
 * Default chunkCount = 1 (single delta). Useful in `Effect.provide(...)` for
 * tests that exercise `LanguageModel.streamText` or `Session.send`.
 */
export const openAiStreamingLayer = (text: string, chunkCount = 1) =>
	OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(Layer.provide(stubOpenAiClientStreaming({ text, chunkCount })));
