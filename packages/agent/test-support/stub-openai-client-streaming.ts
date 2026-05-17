import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Stream } from "effect";
import type { AiError } from "effect/unstable/ai";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { makeStubHttpResponse, makeStubOpenAiClient, type StubOpenAiResponse } from "./stub-openai-client.js";

/**
 * One scripted output for the streaming stub. `text` items are split across
 * `chunkCount` `response.output_text.delta` events; `function_call` items emit
 * `response.output_item.added` + `response.function_call_arguments.done` so
 * `OpenAiLanguageModel.makeStreamResponse` parses them as a real `tool-call`
 * `Response.AnyPart` (handler runs via the toolkit layer in the test).
 */
export type StubStreamOutputItem =
	| { readonly type: "text"; readonly text: string; readonly chunkCount?: number }
	| {
			readonly type: "function_call";
			readonly name: string;
			readonly arguments: string;
			readonly callId?: string;
			readonly itemId?: string;
	  };

export interface StubStreamingOptions {
	/** Shorthand for `outputs: [{ type: "text", text, chunkCount }]`. */
	readonly text?: string;
	/** Number of text deltas to split the shorthand `text` across. Default 1. */
	readonly chunkCount?: number;
	/** Full control: mix text and function_call entries to drive tool-call SSE. */
	readonly outputs?: ReadonlyArray<StubStreamOutputItem>;
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
 * Build the SSE events for one output entry at `outputIndex`. Returns the
 * events in the order the OpenAI streaming protocol would emit them — the
 * caller wraps them with the shared `response.created` / `response.completed`
 * envelope and assigns `sequence_number`s.
 */
const appendSseEvents = (
	body: Array<OpenAiClient.ResponseStreamEvent>,
	item: StubStreamOutputItem,
	outputIndex: number,
	defaultMessageItemId: string,
): void => {
	if (item.type === "text") {
		const chunks = chunkText(item.text, item.chunkCount ?? 1);
		for (let i = 0; i < chunks.length; i++) {
			body.push({
				type: "response.output_text.delta",
				item_id: defaultMessageItemId,
				output_index: outputIndex,
				content_index: i,
				delta: chunks[i] ?? "",
				sequence_number: body.length,
			});
		}
		return;
	}
	const callId = item.callId ?? `call_stub_${outputIndex}`;
	const itemId = item.itemId ?? `fc_stub_${outputIndex}`;
	body.push({
		type: "response.output_item.added",
		output_index: outputIndex,
		sequence_number: body.length,
		item: {
			type: "function_call",
			id: itemId,
			call_id: callId,
			name: item.name,
			arguments: "",
		},
	});
	body.push({
		type: "response.function_call_arguments.done",
		output_index: outputIndex,
		item_id: itemId,
		arguments: item.arguments,
		sequence_number: body.length,
	});
};

/**
 * A Layer providing {@link OpenAiClient} with a streaming `createResponseStream`
 * that emits SSE events reconstructing into the requested `outputs`:
 *
 * - Default / `text` shorthand: `response.created` → N × `response.output_text.delta`
 *   → `response.completed`. Consumers reconstruct the text by concatenating
 *   `text-delta` parts from `LanguageModel.streamText`.
 * - `outputs` with `function_call` entries: emits
 *   `response.output_item.added` + `response.function_call_arguments.done`
 *   per entry so the upstream parser produces a real `tool-call` part. The
 *   toolkit handler (provided via Layer at the test site) then runs and the
 *   `tool-result` part follows automatically.
 *
 * `createResponse` and `createEmbedding` die on call — use the non-streaming
 * stubs for those paths.
 */
export const stubOpenAiClientStreaming = (options: StubStreamingOptions) => {
	const responseId = options.responseId ?? "resp_stream_stub";
	const model = options.model ?? "stub-model";
	const defaultMessageItemId = options.itemId ?? "msg_stream_stub";
	const items: ReadonlyArray<StubStreamOutputItem> =
		options.outputs ??
		(options.text !== undefined ? [{ type: "text", text: options.text, chunkCount: options.chunkCount }] : []);

	const fakeResponse: StubOpenAiResponse = {
		id: responseId,
		created_at: 0,
		model,
		output: [],
	};

	const body: Array<OpenAiClient.ResponseStreamEvent> = [
		{ type: "response.created", response: fakeResponse, sequence_number: 0 },
	];
	let outputIndex = 0;
	for (const item of items) {
		appendSseEvents(body, item, outputIndex, defaultMessageItemId);
		outputIndex++;
	}
	body.push({ type: "response.completed", response: fakeResponse, sequence_number: body.length });

	const createResponseStream: OpenAiClient.Service["createResponseStream"] = () => {
		const tuple: readonly [
			HttpClientResponse.HttpClientResponse,
			Stream.Stream<OpenAiClient.ResponseStreamEvent, AiError.AiError>,
		] = [makeStubHttpResponse(), Stream.fromIterable(body)];
		return Effect.succeed(tuple);
	};

	return Layer.succeed(OpenAiClient.OpenAiClient, makeStubOpenAiClient({ createResponseStream }));
};
