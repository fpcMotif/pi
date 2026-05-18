/**
 * Tracer bullet for tool turns persisted in `state.history`.
 *
 * Extends slice #18 (text history) with tool-call + tool-result parts.
 * After a `send` whose upstream stream emits `tool-call` and `tool-result`
 * parts (via the bypass-the-provider `stubLanguageModelStream` test helper),
 * `state.history` should contain:
 *
 * - one `user` message with the prompt
 * - one `assistant` message whose `content` array contains both the
 *   `tool-call` and `tool-result` parts (and any surrounding text).
 *
 * Streaming-only artifacts (`tool-params-*`, `response-metadata`, `finish`)
 * are NOT persisted — they're event-only.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";

import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

describe("Session.send persists tool turns into state.history", () => {
	it.effect(
		"a send with text + tool-call + tool-result produces user + assistant(text + tool-call + tool-result)",
		() =>
			Effect.gen(function* () {
				const session = yield* Session.empty;

				yield* Stream.runDrain(session.send("What's the weather in Paris?"));

				const snapshot = yield* SubscriptionRef.get(session.state);
				expect(snapshot.history.content).toHaveLength(2);

				const [userMsg, assistantMsg] = snapshot.history.content as ReadonlyArray<{
					readonly role: string;
					readonly content: unknown;
				}>;
				expect(userMsg.role).toBe("user");
				expect(assistantMsg.role).toBe("assistant");

				// Assistant content is an array of parts ordered: text, tool-call, tool-result.
				const parts = (assistantMsg as { readonly content: ReadonlyArray<{ readonly type: string }> }).content;
				expect(parts.map((p) => p.type)).toEqual(["text", "tool-call", "tool-result"]);

				// The tool-call and tool-result parts carry the right name / fields.
				const toolCall = parts[1] as {
					readonly type: "tool-call";
					readonly name: string;
					readonly params: unknown;
				};
				expect(toolCall.name).toBe("GetWeather");
				expect(toolCall.params).toEqual({ city: "Paris" });

				const toolResult = parts[2] as {
					readonly type: "tool-result";
					readonly name: string;
					readonly isFailure: boolean;
					readonly result: unknown;
				};
				expect(toolResult.name).toBe("GetWeather");
				expect(toolResult.isFailure).toBe(false);
				expect(toolResult.result).toEqual({ temperature: 72, condition: "sunny" });
			}).pipe(
				Effect.provide(
					stubLanguageModelStream([
						{ type: "text-delta", id: "msg_1", delta: "Looking up weather... " },
						{
							type: "tool-call",
							id: "call_w1",
							name: "GetWeather",
							params: { city: "Paris" },
							providerExecuted: false,
						},
						{
							type: "tool-result",
							id: "call_w1",
							name: "GetWeather",
							isFailure: false,
							result: { temperature: 72, condition: "sunny" },
							providerExecuted: false,
						},
					]),
				),
			),
	);
});
