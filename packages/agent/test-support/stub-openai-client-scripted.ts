import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, Ref } from "effect";
import type { AiError } from "effect/unstable/ai";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { buildOpenAiOutput, type StubOutputItem } from "./stub-openai-client.js";

export type StubScriptStep =
	| {
			readonly type: "body";
			readonly outputs: ReadonlyArray<StubOutputItem>;
			readonly responseId?: string;
			readonly model?: string;
	  }
	| { readonly type: "error"; readonly error: AiError.AiError };

const cannedResponse = {
	request: HttpClientRequest.post("https://stub.openai.invalid/v1/responses"),
	status: 200,
	headers: Headers.empty,
};

/**
 * A Layer providing {@link OpenAiClient} whose `createResponse` consumes a
 * scripted sequence of steps — one body or one error per call, in order. Used
 * for multi-turn tests where each request needs a different response. Calls
 * beyond the script length die loudly so accidental extra calls are visible.
 */
export const stubOpenAiClientScripted = (script: ReadonlyArray<StubScriptStep>) =>
	Layer.effect(
		OpenAiClient.OpenAiClient,
		Effect.gen(function* () {
			const callIndex = yield* Ref.make(0);
			return OpenAiClient.OpenAiClient.of({
				client: undefined as never,
				createResponse: ((_request: unknown) =>
					Effect.gen(function* () {
						const i = yield* Ref.getAndUpdate(callIndex, (n) => n + 1);
						const step = script[i];
						if (!step) {
							return yield* Effect.die(
								`stubOpenAiClientScripted: no scripted response for call ${i} (script length: ${script.length})`,
							);
						}
						if (step.type === "error") {
							return yield* Effect.fail(step.error);
						}
						const cannedBody = {
							id: step.responseId ?? `resp_stub_${i}`,
							created_at: 0,
							model: step.model ?? "stub-model",
							output: step.outputs.map(buildOpenAiOutput),
						};
						return [cannedBody, cannedResponse];
					})) as never,
				createResponseStream: (() =>
					Effect.die("stubOpenAiClientScripted: createResponseStream not implemented")) as never,
				createEmbedding: (() => Effect.die("stubOpenAiClientScripted: createEmbedding not implemented")) as never,
			});
		}),
	);
