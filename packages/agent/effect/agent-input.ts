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
 *
 * `Session.send` still accepts a bare `string` for backward compatibility
 * (existing tests + simple callers); strings are normalised to
 * `new NewPrompt({ prompt })` at the top of `send`.
 */
import { Schema } from "effect";
import { Prompt } from "effect/unstable/ai";

export class NewPrompt extends Schema.TaggedClass<NewPrompt>()("NewPrompt", {
	prompt: Schema.String,
}) {}

export class Continue extends Schema.TaggedClass<Continue>()("Continue", {}) {}

export class Retry extends Schema.TaggedClass<Retry>()("Retry", {}) {}

export const Input = Schema.Union([NewPrompt, Continue, Retry]);
export type Input = NewPrompt | Continue | Retry;

/**
 * Lift a raw `string` or `Input` to a canonical `Input` value.
 * `Session.send` calls this at the top of every invocation.
 */
export const normalize = (input: string | Input): Input =>
	typeof input === "string" ? new NewPrompt({ prompt: input }) : input;

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
	// Re-encode the slice as a Prompt via `Prompt.make`. The encoded message
	// shape lines up with what Prompt.make expects.
	return Prompt.make(messages.slice(0, lastUserIdx + 1) as never);
};
