import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import type { AiError } from "effect/unstable/ai";

import { makeScriptedCursor } from "./scripted-cursor.js";
import {
	buildOpenAiOutput,
	makeStubOpenAiClient,
	succeedOpenAiResponse,
	type StubOpenAiResponse,
	type StubOutputItem,
} from "./stub-openai-client.js";

export type StubScriptStep =
	| {
			readonly type: "body";
			readonly outputs: ReadonlyArray<StubOutputItem>;
			readonly responseId?: string;
			readonly model?: string;
	  }
	| { readonly type: "error"; readonly error: AiError.AiError };

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
			const cursor = yield* makeScriptedCursor;
			return makeStubOpenAiClient({
				createResponse: () =>
					Effect.gen(function* () {
						const i = yield* cursor.next;
						const step = script[i];
						if (!step) {
							return yield* Effect.die(
								`stubOpenAiClientScripted: no scripted response for call ${i} (script length: ${script.length})`,
							);
						}
						if (step.type === "error") {
							return yield* Effect.fail(step.error);
						}
						const cannedBody: StubOpenAiResponse = {
							id: step.responseId ?? `resp_stub_${i}`,
							created_at: 0,
							model: step.model ?? "stub-model",
							output: step.outputs.map(buildOpenAiOutput),
						};
						return yield* succeedOpenAiResponse(cannedBody);
					}),
			});
		}),
	);
