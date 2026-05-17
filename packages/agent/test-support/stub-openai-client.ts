import { OpenAiClient, OpenAiSchema } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import type { AiError } from "effect/unstable/ai";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { notImplemented } from "./_not-implemented.js";

const OWNER = "stub OpenAiClient";

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

export type StubOpenAiResponse = typeof OpenAiSchema.Response.Type;
export type StubOpenAiOutputItem = StubOpenAiResponse["output"][number];

const stubRequest = HttpClientRequest.post("https://stub.openai.invalid/v1/responses");

export const makeStubHttpResponse = (): HttpClientResponse.HttpClientResponse =>
	HttpClientResponse.fromWeb(stubRequest, new globalThis.Response(null, { status: 200 }));

export const stubHttpClient = HttpClient.make(() => notImplemented(OWNER, "raw HTTP client"));

// Single-method stubs that intentionally die on every other method. Kept
// internal because every external caller goes through `makeStubOpenAiClient` —
// new test slices that need a different method override pass it as an option.
const dieCreateResponse: OpenAiClient.Service["createResponse"] = () => notImplemented(OWNER, "createResponse");
const dieCreateResponseStream: OpenAiClient.Service["createResponseStream"] = () =>
	notImplemented(OWNER, "createResponseStream");
const dieCreateEmbedding: OpenAiClient.Service["createEmbedding"] = () => notImplemented(OWNER, "createEmbedding");

export interface StubOpenAiClientOverrides {
	readonly createResponse?: OpenAiClient.Service["createResponse"];
	readonly createResponseStream?: OpenAiClient.Service["createResponseStream"];
	readonly createEmbedding?: OpenAiClient.Service["createEmbedding"];
}

export const makeStubOpenAiClient = (overrides: StubOpenAiClientOverrides = {}): OpenAiClient.Service =>
	OpenAiClient.OpenAiClient.of({
		client: stubHttpClient,
		createResponse: overrides.createResponse ?? dieCreateResponse,
		createResponseStream: overrides.createResponseStream ?? dieCreateResponseStream,
		createEmbedding: overrides.createEmbedding ?? dieCreateEmbedding,
	});

export const succeedOpenAiResponse = (
	response: StubOpenAiResponse,
): Effect.Effect<readonly [StubOpenAiResponse, HttpClientResponse.HttpClientResponse]> => {
	const tuple: readonly [StubOpenAiResponse, HttpClientResponse.HttpClientResponse] = [
		response,
		makeStubHttpResponse(),
	];

	return Effect.succeed(tuple);
};

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

	const cannedBody: StubOpenAiResponse = {
		id: responseId,
		created_at: 0,
		model,
		output: items.map(buildOpenAiOutput),
	};

	const error = options.error;
	const createResponseImpl: OpenAiClient.Service["createResponse"] =
		error === undefined ? () => succeedOpenAiResponse(cannedBody) : () => Effect.fail(error);

	return Layer.succeed(OpenAiClient.OpenAiClient, makeStubOpenAiClient({ createResponse: createResponseImpl }));
};
