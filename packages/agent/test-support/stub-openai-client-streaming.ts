import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Stream } from "effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export type StreamingOutputItem =
	| { readonly type: "text"; readonly text: string; readonly chunkCount?: number }
	| {
			readonly type: "function_call";
			readonly name: string;
			readonly arguments: string;
			readonly callId?: string;
			readonly itemId?: string;
			readonly argumentChunkCount?: number;
	  };

export interface StubStreamingOptions {
	/** Shorthand for `outputs: [{ type: "text", text, chunkCount }]`. */
	readonly text?: string;
	/** Used with `text`. Number of `response.output_text.delta` events the text is split across. */
	readonly chunkCount?: number;
	/** Full control over the output sequence. Items can mix text and function_call. */
	readonly outputs?: ReadonlyArray<StreamingOutputItem>;
	readonly responseId?: string;
	readonly model?: string;
}

const chunkText = (text: string, chunkCount: number): ReadonlyArray<string> => {
	if (chunkCount <= 1 || text.length === 0) return [text];
	const size = Math.max(1, Math.ceil(text.length / chunkCount));
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
};

const buildItemEvents = (
	item: StreamingOutputItem,
	outputIndex: number,
	startSeq: number,
): ReadonlyArray<Record<string, unknown>> => {
	if (item.type === "text") {
		const itemId = `msg_${outputIndex}`;
		const chunks = chunkText(item.text, item.chunkCount ?? 1);
		return chunks.map((delta, i) => ({
			type: "response.output_text.delta",
			item_id: itemId,
			output_index: outputIndex,
			content_index: 0,
			delta,
			sequence_number: startSeq + i,
		}));
	}
	// function_call
	const itemId = item.itemId ?? `fc_${outputIndex}`;
	const callId = item.callId ?? `call_${outputIndex}`;
	const argChunks = chunkText(item.arguments, item.argumentChunkCount ?? 1);
	const events: Record<string, unknown>[] = [];
	let seq = startSeq;

	events.push({
		type: "response.output_item.added",
		output_index: outputIndex,
		sequence_number: seq++,
		item: { type: "function_call", id: itemId, call_id: callId, name: item.name, arguments: "" },
	});
	for (const delta of argChunks) {
		events.push({
			type: "response.function_call_arguments.delta",
			item_id: itemId,
			output_index: outputIndex,
			sequence_number: seq++,
			delta,
		});
	}
	events.push({
		type: "response.function_call_arguments.done",
		item_id: itemId,
		output_index: outputIndex,
		sequence_number: seq++,
		arguments: item.arguments,
	});
	events.push({
		type: "response.output_item.done",
		output_index: outputIndex,
		sequence_number: seq++,
		item: {
			type: "function_call",
			id: itemId,
			call_id: callId,
			name: item.name,
			arguments: item.arguments,
		},
	});

	return events;
};

/**
 * A Layer providing {@link OpenAiClient} with a streaming `createResponseStream`
 * that emits canned SSE events.
 *
 * **Three usage modes:**
 *
 * - `{ text, chunkCount? }` — single text output split into N deltas. Shortest
 *   form, retained for existing tests.
 * - `{ outputs: [...] }` — full sequence control. Items can be `text` or
 *   `function_call`; the stub emits the appropriate SSE event sequence for
 *   each (`output_item.added` + N × `function_call_arguments.delta` +
 *   `function_call_arguments.done` + `output_item.done` for function calls;
 *   N × `output_text.delta` for text).
 * - Empty `{}` — emits only `response.created` + `response.completed`.
 *
 * `createResponse` and `createEmbedding` die on call.
 */
export const stubOpenAiClientStreaming = (options: StubStreamingOptions) => {
	const responseId = options.responseId ?? "resp_stream_stub";
	const model = options.model ?? "stub-model";

	const items: ReadonlyArray<StreamingOutputItem> =
		options.outputs ??
		(options.text !== undefined ? [{ type: "text", text: options.text, chunkCount: options.chunkCount }] : []);

	const fakeResponse = { id: responseId, created_at: 0, model, usage: undefined };

	const events: Record<string, unknown>[] = [{ type: "response.created", response: fakeResponse, sequence_number: 0 }];

	let seq = 1;
	items.forEach((item, idx) => {
		const itemEvents = buildItemEvents(item, idx, seq);
		for (const e of itemEvents) events.push(e);
		seq += itemEvents.length;
	});

	events.push({ type: "response.completed", response: fakeResponse, sequence_number: seq });

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
