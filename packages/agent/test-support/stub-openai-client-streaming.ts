import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Stream } from "effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export interface StubStreamingOptions {
	/** The text to stream — split into `chunkCount` deltas (default 1). */
	readonly text: string;
	/** Number of `response.output_text.delta` events to split the text across. Default 1. */
	readonly chunkCount?: number;
	readonly responseId?: string;
	readonly model?: string;
	readonly itemId?: string;
}

const chunkText = (text: string, chunkCount: number): ReadonlyArray<string> => {
	if (chunkCount <= 1 || text.length === 0) return [text];
	const size = Math.max(1, Math.ceil(text.length / chunkCount));
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
};

/**
 * A Layer providing {@link OpenAiClient} with a streaming `createResponseStream`
 * that emits a sequence of canned `response.created` → N × `response.output_text.delta`
 * → `response.completed` SSE events, reconstructing into `options.text` when
 * consumers concatenate the `text-delta` parts they receive from
 * `LanguageModel.streamText`.
 *
 * `createResponse` and `createEmbedding` die on call.
 */
export const stubOpenAiClientStreaming = (options: StubStreamingOptions) => {
	const responseId = options.responseId ?? "resp_stream_stub";
	const model = options.model ?? "stub-model";
	const itemId = options.itemId ?? "msg_stream_stub";
	const chunks = chunkText(options.text, options.chunkCount ?? 1);

	const fakeResponse = { id: responseId, created_at: 0, model, usage: undefined };

	const events: ReadonlyArray<Record<string, unknown>> = [
		{ type: "response.created", response: fakeResponse, sequence_number: 0 },
		...chunks.map((delta, i) => ({
			type: "response.output_text.delta",
			item_id: itemId,
			output_index: 0,
			content_index: 0,
			delta,
			sequence_number: i + 1,
		})),
		{ type: "response.completed", response: fakeResponse, sequence_number: chunks.length + 1 },
	];

	const cannedHttpResponse = {
		request: HttpClientRequest.post("https://stub.openai.invalid/v1/responses"),
		status: 200,
		headers: Headers.empty,
	};

	return Layer.succeed(
		OpenAiClient.OpenAiClient,
		OpenAiClient.OpenAiClient.of({
			client: undefined as never,
			createResponse: (() => Effect.die("stubOpenAiClientStreaming: createResponse not implemented")) as never,
			createResponseStream: ((_request: unknown) =>
				Effect.succeed([cannedHttpResponse, Stream.fromIterable(events)] as never)) as never,
			createEmbedding: (() => Effect.die("stubOpenAiClientStreaming: createEmbedding not implemented")) as never,
		}),
	);
};
