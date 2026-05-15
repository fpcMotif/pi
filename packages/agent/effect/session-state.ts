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
 * - `compactionCount` — number of times this session has compacted its
 *   history. Bumped each time `Session.send`'s compaction check fires. `0` in
 *   `empty`; preserved by `advance` (the compaction update is the sole writer).
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
	compactionCount: Schema.Number,
}) {
	static readonly empty: SessionState = new SessionState({
		turnCount: 0,
		history: Prompt.empty,
		inputTokens: 0,
		outputTokens: 0,
		compactionCount: 0,
	});

	/**
	 * Returns a new SessionState with the given fields replaced and the rest
	 * carried over. Single construction point so callers can't drop a field
	 * when a new one is added to the class.
	 */
	static readonly with = (
		s: SessionState,
		patch: {
			readonly turnCount?: number;
			readonly history?: Prompt.Prompt;
			readonly inputTokens?: number;
			readonly outputTokens?: number;
			readonly compactionCount?: number;
		},
	): SessionState =>
		new SessionState({
			turnCount: patch.turnCount ?? s.turnCount,
			history: patch.history ?? s.history,
			inputTokens: patch.inputTokens ?? s.inputTokens,
			outputTokens: patch.outputTokens ?? s.outputTokens,
			compactionCount: patch.compactionCount ?? s.compactionCount,
		});

	/**
	 * Returns a new SessionState with `turnCount` incremented and `history`
	 * replaced. Token totals and `compactionCount` are preserved — they
	 * accumulate via separate updates (post-stream for tokens, the compaction
	 * check for `compactionCount`).
	 */
	static readonly advance = (s: SessionState, history: Prompt.Prompt): SessionState =>
		SessionState.with(s, { turnCount: s.turnCount + 1, history });
}
