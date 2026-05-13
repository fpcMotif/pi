/**
 * The pi-defined error union for the `Session.send` Stream's error channel.
 *
 * Per ADR-0009: "Errors are tagged classes in the error channel:
 * `AgentError = ToolError | LlmError | AuthError | SchemaError |
 * CancellationError | CompactionError | ...` via `Schema.TaggedError`.
 * Untyped throws are not allowed inside the loop."
 *
 * This file defines the minimum viable subset for the first `Session.send`
 * implementation. `AuthError` is currently subsumed under `LlmError` (which
 * wraps any `AiError.AiError` reason, including authentication failures).
 * `CompactionError` is deferred until the compaction slice.
 */
import { Schema } from "effect";

/**
 * Wraps an upstream `effect/unstable/ai` `AiError`. The Session stream's loop
 * surfaces every LLM / provider failure (rate limits, auth failures, content
 * policy, network, schema validation on responses) through this single tag —
 * narrow on `aiError.reason._tag` to drive retry / backoff / surfacing.
 *
 * `aiError` is `Schema.Unknown` at this layer because the upstream `AiError`
 * class is itself a discriminated reason union; modelling it inline would
 * import every reason variant. The runtime value is always an
 * `AiError.isAiError(x) === true` instance.
 */
export class LlmError extends Schema.TaggedErrorClass<LlmError>()("LlmError", {
	aiError: Schema.Unknown,
}) {}

/**
 * A tool handler failed in a way that crosses the loop boundary (i.e. the
 * handler's `Effect.fail` was not captured by `failureMode: "return"`). The
 * underlying cause is wrapped because tool failures can carry any
 * caller-defined failure Schema or, for unhandled cases, the wrapping
 * `AiError.ToolResultEncodingError` / `AiError.InvalidToolResultError`.
 */
export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
	toolName: Schema.String,
	toolCallId: Schema.String,
	cause: Schema.Unknown,
}) {}

/**
 * Schema validation failed at the loop boundary — e.g. a persisted message or
 * stored session state failed to decode against its Schema. Distinct from
 * `LlmError`'s wrapped `AiError.ToolResultEncodingError` / `InvalidToolResultError`,
 * which are upstream validation failures inside the LLM pipeline.
 */
export class SchemaError extends Schema.TaggedErrorClass<SchemaError>()("SchemaError", {
	description: Schema.String,
}) {}

/**
 * A durable state side effect failed at the Store boundary. This keeps
 * storage failures inside the AgentError union instead of leaking raw
 * filesystem / key-value-store implementation errors through Session streams.
 */
export class StoreError extends Schema.TaggedErrorClass<StoreError>()("StoreError", {
	store: Schema.String,
	operation: Schema.String,
	message: Schema.String,
	cause: Schema.Unknown,
}) {}

/**
 * The current action fiber was interrupted (per ADR-0008's
 * `Fiber.interrupt(currentActionFiber)` cancellation pattern). This is a
 * **graceful** stop, not a crash — clients should render it as "stopped" not
 * "failed". Has no payload by design.
 */
export class CancellationError extends Schema.TaggedErrorClass<CancellationError>()("CancellationError", {}) {}

/**
 * The closed union of every `AgentError` variant.
 */
export type AgentError = LlmError | ToolError | SchemaError | StoreError | CancellationError;
