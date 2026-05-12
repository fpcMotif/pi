/**
 * `Session` is the public ADR-0009 entry point for the pi agent loop on
 * Effect v4. The current slice:
 *
 * ```ts
 * const session = yield* Session.empty
 * const events = yield* Stream.runCollect(session.send("hello"))
 * ```
 *
 * `send(prompt)` returns a `Stream<AgentEvent, LlmError, LanguageModel.LanguageModel>`:
 *
 * - Each provider `Response.AnyPart` becomes one `LlmPart` event (raw view).
 * - When a `tool-call` part appears, an additional `ToolDispatched` event is
 *   emitted immediately after the `LlmPart` (lifted view, for consumers that
 *   want to observe orchestration without parsing parts).
 * - When a `tool-result` part appears, an additional `ToolCompleted` event is
 *   emitted immediately after the `LlmPart`.
 * - Upstream `AiError`s are mapped onto our pi-defined `LlmError` via
 *   `Stream.mapError` so callers can `Stream.runForEach` against the closed
 *   `AgentError` union without knowing about Effect's provider error variants.
 * - A trailing `Finish` event is appended via `Stream.concat`.
 *
 * Deferred to follow-on slices (each becomes its own tracer bullet):
 *
 * - The `Input = NewPrompt | Continue | Retry` discriminated union (`send`
 *   currently takes a bare prompt string).
 * - Toolkit threading on `send` (currently the test fixtures supply the
 *   `LanguageModel.streamText` impl directly via Layer; real callers will
 *   pass a `toolkit` so the upstream provider can dispatch tool calls).
 * - Multi-turn history (`Chat.empty`-shaped state inside Session).
 * - `Session.state: SubscriptionRef<SessionState>` for snapshot reads.
 * - Token / cost accounting in `Finish`.
 * - Compaction triggers, retry on transient errors, skill-block parsing,
 *   `Effect.withSpan` telemetry -- the wrapping per ADR-0009.
 */
import { Effect, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";

import { LlmError } from "./agent-error.js";
import { type AgentEvent, Finish, LlmPart, ToolCompleted, ToolDispatched } from "./agent-event.js";

export interface Session {
	readonly send: (prompt: string) => Stream.Stream<AgentEvent, LlmError, LanguageModel.LanguageModel>;
}

/**
 * Lift one upstream `Response.AnyPart` into the pi `AgentEvent` view. Every
 * part becomes an `LlmPart`; `tool-call` / `tool-result` parts additionally
 * emit `ToolDispatched` / `ToolCompleted` so consumers can observe
 * orchestration without parsing the parts themselves.
 */
const liftPart = (part: unknown): ReadonlyArray<AgentEvent> => {
	const base = new LlmPart({ part });
	if (typeof part !== "object" || part === null) return [base];

	const tag = (part as { readonly type?: unknown }).type;

	if (tag === "tool-call") {
		const p = part as {
			readonly id: string;
			readonly name: string;
			readonly params: unknown;
		};
		return [base, new ToolDispatched({ toolName: p.name, toolCallId: p.id, params: p.params })];
	}

	if (tag === "tool-result") {
		const p = part as {
			readonly id: string;
			readonly name: string;
			readonly isFailure: boolean;
			readonly result: unknown;
		};
		return [
			base,
			new ToolCompleted({ toolName: p.name, toolCallId: p.id, isFailure: p.isFailure, result: p.result }),
		];
	}

	return [base];
};

/**
 * Build a new `Session`. Stateless for now -- the empty Session has no
 * history or settings; every `send` call is independent. The shape mirrors
 * `Chat.empty` (an `Effect` producing the session instance) so callers can
 * later swap in a stateful builder without changing the call site.
 */
export const Session: { readonly empty: Effect.Effect<Session> } = {
	empty: Effect.sync(
		(): Session => ({
			send: (prompt: string) =>
				LanguageModel.streamText({ prompt }).pipe(
					Stream.flatMap((part) => Stream.fromIterable(liftPart(part))),
					Stream.mapError((aiError): LlmError => new LlmError({ aiError })),
					Stream.concat(Stream.succeed<AgentEvent>(new Finish({}))),
				),
		}),
	),
};
