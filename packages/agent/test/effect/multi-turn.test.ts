import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { Chat } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClientScripted } from "../../test-support/stub-openai-client-scripted.js";

describe("Chat (multi-turn history accumulation)", () => {
	it.effect("two generateText calls accumulate user+assistant pairs in chat.history", () =>
		Effect.gen(function* () {
			const chat = yield* Chat.empty;

			const initial = yield* Ref.get(chat.history);
			expect(initial.content).toHaveLength(0);

			const r1 = yield* chat.generateText({ prompt: "What is the capital of France?" });
			expect(r1.text).toBe("Paris.");

			const afterFirst = yield* Ref.get(chat.history);
			// one user message + one assistant message
			expect(afterFirst.content).toHaveLength(2);

			const r2 = yield* chat.generateText({ prompt: "And of Germany?" });
			expect(r2.text).toBe("Berlin.");

			const afterSecond = yield* Ref.get(chat.history);
			// two user messages + two assistant messages
			expect(afterSecond.content).toHaveLength(4);

			// The first user message should still be there — history is appended-to, not replaced
			const roles = afterSecond.content.map((m) => m.role);
			expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
		}).pipe(
			Effect.provide(
				OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
					Layer.provide(
						stubOpenAiClientScripted([
							{ type: "body", outputs: [{ type: "text", text: "Paris." }] },
							{ type: "body", outputs: [{ type: "text", text: "Berlin." }] },
						]),
					),
				),
			),
		),
	);
});
