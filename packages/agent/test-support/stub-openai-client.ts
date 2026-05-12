import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import type { AiError } from "effect/unstable/ai";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export type StubOutputItem =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "function_call";
			readonly name: string;
			readonly arguments: string;
			readonly callId?: string;
			readonly itemId?: string;
	  };

export interface StubOpenAiClientOptions {
	/** Shorthand for `outputs: [{ type: "text", text }]`. */
	readonly text?: string;
	/** Full control over the OpenAI Responses-API `output` array (mapped to the wire shape). */
	readonly outputs?: ReadonlyArray<StubOutputItem>;
	readonly responseId?: string;
	readonly model?: string;
	/**
	 * When set, `createResponse` fails with this `AiError` instead of returning a body —
	 * use to drive error-mapping tests (rate limits, auth failures, content policy, ...).
	 */
	readonly error?: AiError.AiError;
}

export const buildOpenAiOutput = (item: StubOutputItem): Record<string, unknown> => {
	if (item.type === "text") {
		return {
			type: "message",
			id: "msg_stub",
			role: "assistant",
			status: "completed",
			content: [
				{
					type: "output_text",
					text: item.text,
					annotations: [],
					logprobs: [],
				},
			],
		};
	}
	return {
		type: "function_call",
		id: item.itemId ?? "fc_stub",
		call_id: item.callId ?? "call_stub",
		name: item.name,
		arguments: item.arguments,
	};
};

/**
 * A Layer providing {@link OpenAiClient} with a canned `createResponse` body —
 * used to drive `OpenAiLanguageModel.layer` end-to-end in tests without an API
 * key. Pass `text` for a single text response, `outputs` for full control
 * (text + function_call mixes), or `error` to make `createResponse` fail.
 *
 * `createResponseStream` and `createEmbedding` die on call; add real stubs when
 * a slice exercises them.
 */
export const stubOpenAiClient = (options: StubOpenAiClientOptions) => {
	const responseId = options.responseId ?? "resp_stub";
	const model = options.model ?? "stub-model";
	const items: ReadonlyArray<StubOutputItem> =
		options.outputs ?? (options.text !== undefined ? [{ type: "text", text: options.text }] : []);

	const cannedBody = {
		id: responseId,
		created_at: 0,
		model,
		output: items.map(buildOpenAiOutput),
	};

	const cannedResponse = {
		request: HttpClientRequest.post("https://stub.openai.invalid/v1/responses"),
		status: 200,
		headers: Headers.empty,
	};

	const createResponseImpl = options.error
		? (((_request: unknown) => Effect.fail(options.error)) as never)
		: (((_request: unknown) => Effect.succeed([cannedBody, cannedResponse] as never)) as never);

	return Layer.succeed(
		OpenAiClient.OpenAiClient,
		OpenAiClient.OpenAiClient.of({
			client: undefined as never,
			createResponse: createResponseImpl,
			createResponseStream: (() => Effect.die("stubOpenAiClient: createResponseStream not implemented")) as never,
			createEmbedding: (() => Effect.die("stubOpenAiClient: createEmbedding not implemented")) as never,
		}),
	);
};
