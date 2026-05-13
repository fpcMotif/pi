/**
 * Per-session state observed alongside the `Session.send` Stream (ADR-0009).
 *
 * Fields land on this same Schema.Class so consumers observe one coherent
 * snapshot. Current fields:
 *
 * - `turnCount` — number of completed `send` calls. Bumps atomically with
 *   each new send before the upstream stream starts emitting.
 * - `history` — accumulated `Prompt.Prompt` of user + assistant messages
 *   across all `send` calls. Each new `send` appends the user prompt, the
 *   stream-text from the assistant gets accumulated as it flows, and after
 *   the upstream stream completes the assembled assistant message is
 *   appended too. Read snapshots via `SubscriptionRef.get(session.state)`.
 * - `inputTokens` / `outputTokens` — cumulative token totals across every
 *   `send`. Populated from upstream `finish` parts' `usage.{input,output}Tokens.total`
 *   (undefined values fall through as 0). Reset to 0 in `empty`.
 *
 * Future fields (model, pending tool calls, cancellation flag, lastResponseId)
 * land here as their slices materialise.
 */
import { Schema } from "effect";
import { Prompt } from "effect/unstable/ai";

export class SessionState extends Schema.Class<SessionState>("SessionState")({
	turnCount: Schema.Number,
	history: Prompt.Prompt,
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
}) {
	static readonly empty: SessionState = new SessionState({
		turnCount: 0,
		history: Prompt.empty,
		inputTokens: 0,
		outputTokens: 0,
	});

	/**
	 * Returns a new SessionState with `turnCount` incremented and `history`
	 * replaced. Single writer for both fields so the snapshot is always
	 * consistent. Token totals are preserved — they accumulate via a separate
	 * post-stream update once the upstream `finish` part lands.
	 */
	static readonly advance = (s: SessionState, history: Prompt.Prompt): SessionState =>
		new SessionState({
			turnCount: s.turnCount + 1,
			history,
			inputTokens: s.inputTokens,
			outputTokens: s.outputTokens,
		});
}
