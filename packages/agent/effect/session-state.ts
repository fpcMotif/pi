/**
 * Per-session state observed alongside the `Session.send` Stream (ADR-0009).
 *
 * The first slice carries only `turnCount` -- incremented each time the loop
 * processes a fresh user input. Future slices add message history, current
 * model selection, accumulated usage / cost, pending tool calls, and the
 * cancellation flag; each is added as a Schema field rather than a separate
 * Ref so consumers observe a single coherent snapshot.
 */
import { Schema } from "effect";

export class SessionState extends Schema.Class<SessionState>("SessionState")({
	turnCount: Schema.Number,
}) {
	static readonly empty: SessionState = new SessionState({ turnCount: 0 });
}
