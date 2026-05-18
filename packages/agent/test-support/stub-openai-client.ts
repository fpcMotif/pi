import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import type { AiError } from "effect/unstable/ai";

import {
	buildOpenAiOutput,
	notImplementedCreateEmbedding,
	notImplementedCreateResponseStream,
	type StubOpenAiResponse,
	type StubOutputItem,
	stubHttpClient,
	succeedOpenAiResponse,
} from "./openai-stub-helpers.js";

export { type StubOutputItem, type StubOpenAiResponse, type StubOpenAiOutputItem } from "./openai-stub-helpers.js";
export {
	stubHttpClient,
	makeStubHttpResponse,
	notImplementedCreateResponse,
	notImplementedCreateResponseStream,
	notImplementedCreateEmbedding,
	succeedOpenAiResponse,
	buildOpenAiOutput,
} from "./openai-stub-helpers.js";

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

	return Layer.succeed(
		OpenAiClient.OpenAiClient,
		OpenAiClient.OpenAiClient.of({
			client: stubHttpClient,
			createResponse: createResponseImpl,
			createResponseStream: notImplementedCreateResponseStream,
			createEmbedding: notImplementedCreateEmbedding,
		}),
	);
};
