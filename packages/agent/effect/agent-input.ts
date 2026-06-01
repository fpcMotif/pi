/**
 * Tagged input accepted by `Session.send`, per ADR-0009:
 *
 *   `type Input = NewPrompt | Continue | Retry`
 *
 * Each variant routes through a different path inside `Session.send`:
 *
 * - **`NewPrompt`** — the model speaks in response to a fresh user prompt.
 *   `send` appends a `user` message with `prompt` to `state.history` BEFORE
 *   opening the upstream stream.
 * - **`Continue`** — the model continues from where it left off (no new user
 *   message). `send` leaves `state.history` alone; the upstream sees the
 *   existing conversation and produces another assistant turn.
 * - **`Retry`** — re-run the previous turn. `send` rolls back `state.history`
 *   to the last `user` message (dropping the trailing assistant/tool turn
 *   that came after), then calls the LLM again with the rolled-back history.
 *   Use this when the previous attempt failed or produced an unwanted
 *   response and you want a fresh take on the same prompt.
 * - **`AcceptedPromptEnvelope`** — a host-preflighted prompt turn. The host
 *   has already run skill/prompt-template expansion, extension input
 *   transforms, and model/auth preflight; `send` owns ordering the injected
 *   messages and final user content into history.
 *
 * `Session.send` still accepts a bare `string` for backward compatibility
 * (existing tests + simple callers); strings are normalised to
 * `new NewPrompt({ prompt })` at the top of `send`.
 */
import { Effect, Schema } from "effect";
import { Prompt } from "effect/unstable/ai";

import { SchemaError } from "./agent-error.js";

export class NewPrompt extends Schema.TaggedClass<NewPrompt>()("NewPrompt", {
	prompt: Schema.String,
}) {}

export class Continue extends Schema.TaggedClass<Continue>()("Continue", {}) {}

export class Retry extends Schema.TaggedClass<Retry>()("Retry", {}) {}

export class AcceptedPromptEnvelope extends Schema.TaggedClass<AcceptedPromptEnvelope>()("AcceptedPromptEnvelope", {
	content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
	injectedMessages: Schema.optional(Schema.Array(Schema.Unknown)),
	queueMode: Schema.optional(
		Schema.Union([Schema.Literal("direct"), Schema.Literal("steer"), Schema.Literal("followUp")]),
	),
	source: Schema.optional(Schema.String),
	systemPromptOverride: Schema.optional(Schema.String),
}) {}

export const Input = Schema.Union([NewPrompt, Continue, Retry, AcceptedPromptEnvelope]);
export type Input = NewPrompt | Continue | Retry | AcceptedPromptEnvelope;

/**
 * Lift a raw `string` or `Input` to a canonical `Input` value.
 * `Session.send` calls this at the top of every invocation.
 */
export const normalize = (input: string | Input): Input =>
	typeof input === "string" ? new NewPrompt({ prompt: input }) : input;

const mapAcceptedEnvelopeSchemaError = (error: Schema.SchemaError): SchemaError =>
	new SchemaError({
		description: `Invalid accepted prompt envelope: ${String(error)}`,
	});

/**
 * Build the prompt for an `AcceptedPromptEnvelope`, Schema-validating the
 * host-preflighted `injectedMessages` and the final user message BEFORE they
 * reach `Session.send`'s history. A malformed envelope fails with `SchemaError`
 * (the typed `AgentError` channel) instead of pushing invalid messages into
 * durable state and crashing far downstream in the provider (PR #10 1c234ca9).
 */
export const promptFromAcceptedEnvelope = Effect.fn("promptFromAcceptedEnvelope")(function* (
	envelope: AcceptedPromptEnvelope,
) {
	const injectedMessages = yield* Schema.decodeUnknownEffect(Schema.Array(Prompt.Message))(
		envelope.injectedMessages ?? [],
	).pipe(Effect.mapError(mapAcceptedEnvelopeSchemaError));
	const finalUserMessage = yield* Schema.decodeUnknownEffect(Prompt.UserMessage)({
		role: "user",
		content: envelope.content,
	}).pipe(Effect.mapError(mapAcceptedEnvelopeSchemaError));

	return Prompt.fromMessages([...injectedMessages, finalUserMessage]);
});

/**
 * Roll a `Prompt` back to (and including) its last `user` message. Used by
 * the `Retry` dispatch path to drop the trailing assistant turn before
 * re-sending.
 *
 * - History with at least one `user` message: returns a new prompt whose
 *   `content` slice ends at the last user message. Anything after the last
 *   user (the trailing assistant turn, including in-content tool-call /
 *   tool-result parts) is dropped.
 * - History without any `user` message (empty, system-only, etc.): returned
 *   unchanged — there's nothing to retry against.
 */
export const rollbackToLastUserMessage = (history: Prompt.Prompt): Prompt.Prompt => {
	const messages = history.content;
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	if (lastUserIdx === -1) return history;
	return Prompt.fromMessages(messages.slice(0, lastUserIdx + 1));
};
