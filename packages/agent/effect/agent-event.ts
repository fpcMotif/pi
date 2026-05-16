/**
 * The pi-defined event union emitted by `Session.send`'s Stream. Each element
 * of the stream is one `AgentEvent`; stream completion = the loop is finished.
 *
 * Per ADR-0009 the union is pi-defined (rather than re-exposing
 * `Response.AnyPart` directly) so pi orchestration events (tool dispatch,
 * compaction, retries, session metadata) are first-class peers of the
 * LLM parts instead of side-channels.
 *
 * This file defines the **minimum viable subset** needed by the first
 * `Session.send` implementation. Additional variants (`RetryRequested`,
 * `SessionMeta`) land in their own ADRs / slices.
 *
 * Note: skill loading / skill-block parsing is a **host** (`pi-coding-agent`)
 * concern, not a loop concern — there is no `SkillInvoked` variant (ADR-0009
 * amendment, 2026-05-14).
 */
import { Schema } from "effect";

/**
 * One LLM response part lifted out of `LanguageModel.streamText`. The shape of
 * `part` mirrors `effect/unstable/ai`'s `Response.AnyPart` union; we keep it
 * `Schema.Unknown` at the AgentEvent layer to avoid coupling to the upstream
 * Schema's tool generic — consumers narrow on their own when they need to.
 */
export class LlmPart extends Schema.TaggedClass<LlmPart>()("LlmPart", {
	part: Schema.Unknown,
}) {}

/**
 * The framework has dispatched a tool call. Emitted before the handler runs.
 */
export class ToolDispatched extends Schema.TaggedClass<ToolDispatched>()("ToolDispatched", {
	toolName: Schema.String,
	toolCallId: Schema.String,
	params: Schema.Unknown,
}) {}

/**
 * A tool call has completed (or failed). Emitted after the handler returns.
 */
export class ToolCompleted extends Schema.TaggedClass<ToolCompleted>()("ToolCompleted", {
	toolName: Schema.String,
	toolCallId: Schema.String,
	isFailure: Schema.Boolean,
	result: Schema.Unknown,
}) {}

/**
 * History was compacted before this turn opened. Emitted as the FIRST event of
 * the `Session.send` stream when `shouldCompact(state.history)` fired: the
 * older portion of history was summarised via `LanguageModel.generateText` and
 * `state.history` was rebuilt as `[summary user message, ...recent kept
 * messages]`. `tokensBefore` / `tokensAfter` are `estimateTokens` snapshots
 * either side of the rebuild; `summarizedMessageCount` is how many messages
 * were folded into the summary.
 */
export class CompactionApplied extends Schema.TaggedClass<CompactionApplied>()("CompactionApplied", {
	tokensBefore: Schema.Number,
	tokensAfter: Schema.Number,
	summarizedMessageCount: Schema.Number,
}) {}

/**
 * Terminal event for the Session stream. Carries final accounting that
 * consumers want once the loop is done.
 */
export class Finish extends Schema.TaggedClass<Finish>()("Finish", {
	inputTokens: Schema.optional(Schema.Number),
	outputTokens: Schema.optional(Schema.Number),
}) {}

/**
 * The closed Schema-tagged union of every `AgentEvent` variant.
 */
export const AgentEvent = Schema.Union([LlmPart, ToolDispatched, ToolCompleted, CompactionApplied, Finish]);

export type AgentEvent = LlmPart | ToolDispatched | ToolCompleted | CompactionApplied | Finish;
