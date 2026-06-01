import { OpenAiClient, OpenAiSchema } from "@effect/ai-openai";
import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * One output entry the caller wants the stub to surface. `text` becomes one
 * OpenAI `output_text` block; `function_call` becomes one `function_call`
 * output item with the canned arguments.
 */
export type StubOutputItem =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "function_call";
			readonly name: string;
			readonly arguments: string;
			readonly callId?: string;
			readonly itemId?: string;
	  };

/** The full OpenAI Responses-API response body shape. */
export type StubOpenAiResponse = typeof OpenAiSchema.Response.Type;
export type StubOpenAiOutputItem = StubOpenAiResponse["output"][number];

const stubRequest = HttpClientRequest.post("https://stub.openai.invalid/v1/responses");

/** Minimal `HttpClientResponse` paired with the canned body for the OpenAiClient tuple. */
export const makeStubHttpResponse = (): HttpClientResponse.HttpClientResponse =>
	HttpClientResponse.fromWeb(stubRequest, new globalThis.Response(null, { status: 200 }));

/**
 * Stub `HttpClient.HttpClient` for the `OpenAiClient` Service's `client` slot.
 * Dies on call — tests never reach raw HTTP; they go through `createResponse`
 * / `createResponseStream`.
 */
export const stubHttpClient = HttpClient.make(() =>
	Effect.die("stub OpenAiClient: raw HTTP client is not implemented"),
);

export const notImplementedCreateResponse: OpenAiClient.Service["createResponse"] = () =>
	Effect.die("stub OpenAiClient: createResponse is not implemented");

export const notImplementedCreateResponseStream: OpenAiClient.Service["createResponseStream"] = () =>
	Effect.die("stub OpenAiClient: createResponseStream is not implemented");

export const notImplementedCreateEmbedding: OpenAiClient.Service["createEmbedding"] = () =>
	Effect.die("stub OpenAiClient: createEmbedding is not implemented");

/**
 * Wrap a canned response body into the tuple shape `OpenAiClient.createResponse`
 * returns: `[body, HttpClientResponse]`.
 */
export const succeedOpenAiResponse = (
	response: StubOpenAiResponse,
): Effect.Effect<readonly [StubOpenAiResponse, HttpClientResponse.HttpClientResponse]> => {
	const tuple: readonly [StubOpenAiResponse, HttpClientResponse.HttpClientResponse] = [
		response,
		makeStubHttpResponse(),
	];

	return Effect.succeed(tuple);
};

/** Translate one `StubOutputItem` to its OpenAI Responses-API output shape. */
export const buildOpenAiOutput = (item: StubOutputItem): StubOpenAiOutputItem => {
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
