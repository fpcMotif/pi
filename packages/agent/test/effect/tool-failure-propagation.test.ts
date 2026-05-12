import { OpenAiLanguageModel } from "@effect/ai-openai";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { stubOpenAiClient } from "../../test-support/stub-openai-client.js";

const ServiceDown = Schema.Struct({
	_tag: Schema.Literal("ServiceDown"),
	reason: Schema.String,
});

// Default failureMode is "error" — handler failures propagate through the Effect's error channel.
const FetchOrder = Tool.make("FetchOrder", {
	description: "Fetch an order by id.",
	parameters: Schema.Struct({ orderId: Schema.String }),
	success: Schema.Struct({ total: Schema.Number }),
	failure: ServiceDown,
});

const Orders = Toolkit.make(FetchOrder);

const OrdersHandlers = Orders.toLayer({
	FetchOrder: ({ orderId: _id }) => Effect.fail({ _tag: "ServiceDown" as const, reason: "down for maintenance" }),
});

describe("Tool failure propagation (default failureMode: 'error')", () => {
	it.effect("propagates the handler's Effect.fail value through the error channel", () =>
		Effect.gen(function* () {
			// flip swaps success<->error: if generateText fails with X, this succeeds with X.
			// If it accidentally succeeds, the flipped effect emits the success value via the
			// error channel and the test fails loudly.
			const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "fetch order 42", toolkit: Orders }));

			expect(error).toEqual({ _tag: "ServiceDown", reason: "down for maintenance" });
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					OrdersHandlers,
					OpenAiLanguageModel.layer({ model: "gpt-4" }).pipe(
						Layer.provide(
							stubOpenAiClient({
								outputs: [
									{
										type: "function_call",
										name: "FetchOrder",
										arguments: JSON.stringify({ orderId: "42" }),
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
