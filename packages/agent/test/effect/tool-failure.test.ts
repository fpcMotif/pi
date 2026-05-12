import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

const UpstreamUnavailable = Schema.Struct({
	_tag: Schema.Literal("UpstreamUnavailable"),
	message: Schema.String,
});

const SearchUsers = Tool.make("SearchUsers", {
	description: "Search the user directory.",
	parameters: Schema.Struct({ query: Schema.String }),
	success: Schema.Struct({ users: Schema.Array(Schema.String) }),
	failure: UpstreamUnavailable,
	failureMode: "return",
});

const Search = Toolkit.make(SearchUsers);

const SearchHandlers = Search.toLayer({
	SearchUsers: ({ query: _query }) =>
		Effect.fail({ _tag: "UpstreamUnavailable" as const, message: "directory service timeout" }),
});

describe("Tool failure (failureMode: 'return')", () => {
	it.effect("captures the handler's Effect.fail value as a tool-result with isFailure: true", () =>
		Effect.gen(function* () {
			const response = yield* LanguageModel.generateText({
				prompt: "find admin users",
				toolkit: Search,
			});

			expect(response.toolResults).toHaveLength(1);
			expect(response.toolResults[0].name).toBe("SearchUsers");
			expect(response.toolResults[0].isFailure).toBe(true);
			expect(response.toolResults[0].result).toEqual({
				_tag: "UpstreamUnavailable",
				message: "directory service timeout",
			});
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					SearchHandlers,
					OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
						Layer.provide(
							stubOpenAiClient({
								outputs: [
									{
										type: "function_call",
										name: "SearchUsers",
										arguments: JSON.stringify({ query: "admin" }),
									},
								],
							}),
						),
					),
				),
			),
		),
	);
});
