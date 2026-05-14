import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";

import { AcceptedPromptEnvelope } from "../../effect/agent-input.js";
import { Session } from "../../effect/session.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

const textFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { readonly type: string; readonly text: string } => {
			return (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			);
		})
		.map((part) => part.text)
		.join("");
};

const assistantParts = [{ type: "text-delta", delta: "accepted" }];

describe("Session.send accepts AcceptedPromptEnvelope", () => {
	it.effect("orders injected messages before the final user content", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			yield* Stream.runDrain(
				session.send(
					new AcceptedPromptEnvelope({
						content: "final prompt",
						injectedMessages: [{ role: "user", content: "injected context" }],
						queueMode: "direct",
						source: "test",
					}),
				),
			);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
			expect(snapshot.history.content.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
			expect(textFromContent(snapshot.history.content[0]?.content)).toBe("injected context");
			expect(textFromContent(snapshot.history.content[1]?.content)).toBe("final prompt");
		}).pipe(Effect.provide(stubLanguageModelStream(assistantParts))),
	);

	it.effect("emits Finish and bumps the turn once for accepted envelopes", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			const events = yield* Stream.runCollect(
				session.send(
					new AcceptedPromptEnvelope({
						content: [{ type: "text", text: "array prompt" }],
						queueMode: "followUp",
					}),
				),
			);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.turnCount).toBe(1);
			expect(Array.from(events).at(-1)?._tag).toBe("Finish");
			expect(snapshot.history.content.map((message) => message.role)).toEqual(["user", "assistant"]);
		}).pipe(Effect.provide(stubLanguageModelStream(assistantParts))),
	);

	it.effect("applies systemPromptOverride without exposing host UI metadata", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			yield* Stream.runDrain(
				session.send(
					new AcceptedPromptEnvelope({
						content: "final prompt",
						systemPromptOverride: "custom system",
					}),
				),
			);

			const snapshot = yield* SubscriptionRef.get(session.state);
			expect(snapshot.history.content.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
			expect(snapshot.history.content[0]?.content).toBe("custom system");
			expect(textFromContent(snapshot.history.content[1]?.content)).toBe("final prompt");
		}).pipe(Effect.provide(stubLanguageModelStream(assistantParts))),
	);
});
