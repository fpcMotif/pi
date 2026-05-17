/**
 * `Session` is the public ADR-0009 entry point for the pi agent loop on
 * Effect v4. The current slice:
 *
 * ```ts
 * const session = yield* Session.empty
 * const events = yield* Stream.runCollect(session.send("hello"))
 * ```
 *
 * `send(input, toolkit?)` returns a stream that needs the configured `LanguageModel`
 * plus any service requirements implied by the supplied toolkit:
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
 * **Multi-turn history is accumulated automatically** (this slice):
 *
 * - Before the upstream stream starts emitting, the new user prompt is
 *   appended to `state.history` (via `Prompt.concat`) and `state.turnCount`
 *   is bumped. Both updates happen in a single `SubscriptionRef.update` so
 *   the snapshot is consistent.
 * - The FULL history (including the just-appended user message) is passed
 *   to `LanguageModel.streamText`, so the next turn sees prior turns'
 *   context.
 * - Text-delta parts are accumulated into a `Ref<string>` as the stream
 *   flows. When the upstream completes, the assembled assistant message is
 *   appended to `state.history` (turnCount stays put — it bumped at the
 *   start of this send).
 *
 * `session.state: SubscriptionRef<SessionState>` exposes the observable
 * snapshot per ADR-0009. Components can read snapshots via
 * `SubscriptionRef.get(state)` or subscribe to changes via
 * `SubscriptionRef.changes(state)`.
 *
 * `send` accepts an optional second `toolkit` argument that is forwarded to
 * `LanguageModel.streamText({ prompt, toolkit })`. When provided, the upstream
 * provider dispatches `function_call` events; the resulting `tool-call` /
 * `tool-result` parts surface via the `liftPart` flatMap as `ToolDispatched` /
 * `ToolCompleted` events. Handler resolution services come from the runtime
 * context via `toolkit.toLayer({ ToolName: handler })` and are reflected in
 * the stream's R-type when a typed toolkit is passed.
 *
 * **Tool turns are persisted in history too** (slice 12h):
 *
 * - During the stream, in addition to text-delta accumulation, the
 *   accumulator captures `tool-call` and `tool-result` parts in arrival
 *   order. Streaming-only artifacts (`tool-params-start` /
 *   `tool-params-delta` / `tool-params-end`) are skipped.
 * - When the upstream completes, the accumulator emits one
 *   `AssistantMessage` whose `content` array preserves the original
 *   ordering: text segments collapse into a `TextPart` at each block
 *   boundary (see slice 26 below); `tool-call` / `tool-result` parts appear
 *   inline at their respective positions.
 *
 * **Per-text-block segmentation is wired** (slice 26):
 *
 * - The accumulator now treats `text-start` and `text-end` parts as flush
 *   boundaries: any pending text collected from preceding `text-delta`s
 *   becomes its own `TextPart` at each marker. This preserves multi-block
 *   assistant responses (e.g. `text → tool-call → text` or
 *   `text → reasoning → text`) instead of coalescing all text into one part.
 * - Streams that emit only `text-delta` (no `text-start`/`text-end`) still
 *   produce a single `TextPart` via `finalize` at end-of-stream —
 *   backward-compatible with all earlier slices' tests.
 *
 * **Reasoning blocks are persisted in history too** (slice 27):
 *
 * - The accumulator gains a `pendingReasoning: string` field that mirrors
 *   `pendingText` for `reasoning-delta` parts. `reasoning-start` /
 *   `reasoning-end` flush like `text-start` / `text-end`; flushing emits a
 *   `{ type: "reasoning", text }` part into `content`.
 * - Every delta cross-flushes the OTHER accumulator before appending — so a
 *   `text-delta → reasoning-delta` sequence (no explicit boundary between)
 *   still produces `[text, reasoning]` in arrival order. Tool boundaries
 *   flush both accumulators.
 * - Net effect: a stream like
 *   `text-deltas → tool-call → reasoning-deltas → text-deltas`
 *   produces `[text, tool-call, reasoning, text]` in `state.history`'s
 *   assistant content. Pure text streams behave exactly as before.
 *
 * **Token accounting is wired** (slice 23):
 *
 * - During the stream, a second `Stream.tap` watches for `type === "finish"`
 *   parts and captures `usage.inputTokens.total` / `usage.outputTokens.total`
 *   into a `Ref<Captured | null>`. Undefined totals fall through as 0.
 * - After the upstream completes, the captured tokens populate the trailing
 *   `Finish({ inputTokens, outputTokens })` event AND accumulate into
 *   `state.inputTokens` / `state.outputTokens` (cumulative across sends).
 * - Streams that never emit a `finish` part (e.g. caller cancellation) leave
 *   the ref null; the `Finish` event then has the fields omitted and state
 *   totals stay put.
 *
 * **Transient-error retry is wired** (slice 24):
 *
 * - The per-send pipeline is split into a once-per-send setup (history + turn
 *   update; runs in the outer `Stream.unwrap`) and a per-attempt factory (Ref
 *   creation + upstream open + accumulator pipeline; runs in an inner
 *   `Stream.unwrap` so each retry sees fresh Refs).
 * - The inner stream is wrapped with `Stream.retry(makeRetrySchedule(maxLlmRetries))`,
 *   where `maxLlmRetries = options.maxLlmRetries ?? MAX_LLM_RETRIES` -- a
 *   per-session override that defaults to `MAX_LLM_RETRIES` and where `0`
 *   disables retries entirely. The factory builds
 *   `Schedule.recurs(maxLlmRetries).pipe(Schedule.while(({ input }) => input.aiError.isRetryable))`.
 * - Net effect: on a retryable failure (`RateLimitError`, `OverloadedError`,
 *   `TransportError`, …) the inner stream re-opens with fresh accRef/usageRef
 *   and a fresh upstream; up to `maxLlmRetries` re-attempts (default
 *   `MAX_LLM_RETRIES`, `0` disables). On a non-retryable failure
 *   (`AuthenticationError`, `ContentPolicyError`, `InvalidRequestError`, …)
 *   the predicate is false → schedule halts → error propagates after the
 *   first attempt. After the retry cap is exhausted, the last error
 *   propagates.
 * - History + turnCount are bumped ONCE per `send` (not once per attempt) —
 *   they sit outside the retry boundary.
 * - Mid-stream retry caveat: if events flow then the upstream fails, the
 *   consumer has already observed those events. `Stream.retry` re-opens the
 *   stream, so the retry attempt's events appear *after* the failed
 *   attempt's. For the common transient-error pattern (`createResponseStream`
 *   fails at-open, before any events flow) this is the desired behavior.
 *
 * **`Effect.withSpan` telemetry is wired** (slice 25):
 *
 * - The outer `Stream.unwrap` returns a stream wrapped in
 *   `Stream.withSpan("pi.Session.send", { attributes: { "pi.input.tag", "pi.history.size" } })`.
 *   The span starts when the consumer opens the stream and ends when the
 *   stream completes (success, failure, or interruption — the exit is
 *   attached to `span.status` on close).
 * - Each per-attempt inner stream is wrapped in
 *   `Stream.withSpan("pi.Session.send.attempt", { attributes: { "pi.attempt.number" } })`.
 *   The attempt counter lives in a `Ref<number>` created in the outer
 *   `Stream.unwrap`; the inner `Effect.gen` reads & bumps it on each entry,
 *   so retries appear as separate sibling attempt spans (1, 2, 3, …) all
 *   parented to the same `pi.Session.send` span.
 * - The default `Tracer.Tracer` is a no-op until a real tracer is provided
 *   via `Effect.provideService(Tracer.Tracer, ...)`. Tests use
 *   `test-support/recording-tracer.ts` (`NativeSpan`-backed in-memory tracer)
 *   to assert on span names and attributes.
 *
 * Deferred to follow-on slices (each becomes its own tracer bullet):
 *
 * - Backoff on retry (currently no delay between attempts; production wants
 *   exponential / `retryAfter`-respecting backoff).
 * - Configurable retry policy on `Session.empty` (currently hardcoded to
 *   `MAX_LLM_RETRIES = 3` and `while-isRetryable`).
 *
 * (Skill-block parsing is NOT a loop concern — it is a host (`pi-coding-agent`)
 * responsibility; the loop consumes already-expanded prompts. See the ADR-0009
 * amendment, 2026-05-14.)
 */
import { Effect, Option, Ref, Schedule, Stream, SubscriptionRef, type Types } from "effect";
import { LanguageModel, Prompt, type Tool } from "effect/unstable/ai";

import { type AgentError, CompactionError, LlmError } from "./agent-error.js";
import { type AgentEvent, CompactionApplied, Finish, LlmPart, ToolCompleted, ToolDispatched } from "./agent-event.js";
import {
	type Input,
	normalize as normalizeInput,
	promptFromAcceptedEnvelope,
	rollbackToLastUserMessage,
} from "./agent-input.js";
import { COMPACTION_THRESHOLD, estimateTokens, KEEP_RECENT_TOKENS, splitHistory } from "./compaction.js";
import { composeHooks, Hooks } from "./hooks.js";
import { SessionState } from "./session-state.js";
import { SessionStore } from "./stores/session-store.js";

/**
 * Instruction appended after the to-summarise history slice when compaction
 * fires. The provider sees the older conversation followed by this user
 * message and returns a structured context checkpoint another assistant can
 * load to continue the work. The instruction asks for explicit markdown
 * sections so the summary stays parseable and the next turn can rely on a
 * predictable shape (slice 38 — structured-checkpoint summary prompt). The
 * preamble asks the model to preserve exact file paths, function names,
 * error messages, and constraints verbatim — the conversation prefix being
 * summarised is DISCARDED after compaction, so anything not captured here is
 * lost from the long-term session state. Empty sections are omitted rather
 * than padded. See ADR-0019 for the design evolution (initial four-section
 * simplification was corrected to five sections + preservation preamble
 * after codex adversarial review surfaced the load-bearing-facts regression).
 */
const SUMMARIZATION_INSTRUCTION =
	"Summarize the conversation above into a structured context checkpoint that another assistant can load to continue the work. Preserve exact file paths, function names, error messages, and any constraints or blockers verbatim — the conversation prefix being summarised will be DISCARDED, so anything not captured here is lost. Use the following markdown sections, omitting any that would be empty:\n\n" +
	"## Goals\n" +
	"- The user-facing goals of this session, prioritised.\n\n" +
	"## Decisions\n" +
	"- Material decisions made and their rationale.\n\n" +
	"## Files Touched\n" +
	"- Exact file paths read, written, edited, or referenced.\n\n" +
	"## Critical Context\n" +
	"- Constraints, preferences, blockers, exact function names, error messages, or any other detail the next assistant must NOT forget.\n\n" +
	"## Next Steps\n" +
	"- Concrete actions the next assistant should take.";

/**
 * `Session.send` is generic over the toolkit's `Tools` map so that callers
 * passing a concrete `Toolkit.make(GetWeather, ...)` get the precise inferred
 * shape — `Record<string, Tool.Any>` as the slot type would be too wide
 * (`Toolkit<{ GetWeather }>` is NOT assignable to `Toolkit<Record<...>>`
 * because Record's index signature requires every key to exist).
 *
 * Handler resolution services land in the call's runtime context (via the
 * `WeatherHandlers` Layer at the use site) and are carried by the returned
 * stream's R-type.
 */
type ToolkitServices<ToolkitValue> = ToolkitValue extends undefined
	? never
	: LanguageModel.ExtractServices<{ readonly toolkit: ToolkitValue }>;

export interface Session {
	readonly state: SubscriptionRef.SubscriptionRef<SessionState>;
	readonly send: <Tools extends Record<string, Tool.Any> = {}>(
		input: string | Input,
		toolkit?: LanguageModel.ToolkitInput<Tools>,
		concurrency?: Types.Concurrency,
	) => Stream.Stream<
		AgentEvent,
		AgentError,
		LanguageModel.LanguageModel | ToolkitServices<LanguageModel.ToolkitInput<Tools>>
	>;
}

interface MakeOptions {
	readonly initialState: SessionState;
	readonly persist: (state: SessionState) => Effect.Effect<void, AgentError>;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;

const hasStringProperty = <Key extends PropertyKey>(
	value: Record<PropertyKey, unknown>,
	key: Key,
): value is Record<Key, string> & Record<PropertyKey, unknown> => typeof value[key] === "string";

/**
 * Lift one upstream `Response.AnyPart` into the pi `AgentEvent` view. Every
 * part becomes an `LlmPart`; `tool-call` / `tool-result` parts additionally
 * emit `ToolDispatched` / `ToolCompleted` so consumers can observe
 * orchestration without parsing the parts themselves.
 */
const liftPart = (part: unknown): ReadonlyArray<AgentEvent> => {
	const base = new LlmPart({ part });
	if (!isRecord(part)) return [base];

	const tag = part.type;

	if (tag === "tool-call" && hasStringProperty(part, "id") && hasStringProperty(part, "name")) {
		return [base, new ToolDispatched({ toolName: part.name, toolCallId: part.id, params: part.params })];
	}

	if (
		tag === "tool-result" &&
		hasStringProperty(part, "id") &&
		hasStringProperty(part, "name") &&
		typeof part.isFailure === "boolean"
	) {
		return [
			base,
			new ToolCompleted({
				toolName: part.name,
				toolCallId: part.id,
				isFailure: part.isFailure,
				result: part.result,
			}),
		];
	}

	return [base];
};

/**
 * Accumulator state for assembling one `AssistantMessage` worth of content as
 * the upstream stream flows. Text deltas collapse into `pendingText` between
 * boundaries; on each `text-start` / `text-end` / `tool-call` / `tool-result`
 * the pendingText (if any) flushes to a `TextPart` and (for tool parts) the
 * tool part appends — preserving arrival order AND per-text-block granularity
 * in the final `content` array. Streams that emit raw `text-delta` without
 * `text-start` / `text-end` markers still coalesce into one `TextPart` via
 * `finalize` at end-of-stream (backward-compatible).
 */
interface AssistantContentAcc {
	readonly pendingText: string;
	readonly pendingReasoning: string;
	readonly parts: ReadonlyArray<Prompt.AssistantMessagePart>;
}

const initialAcc: AssistantContentAcc = { pendingText: "", pendingReasoning: "", parts: [] };

const flushText = (acc: AssistantContentAcc): AssistantContentAcc =>
	acc.pendingText.length === 0
		? acc
		: { ...acc, pendingText: "", parts: [...acc.parts, Prompt.makePart("text", { text: acc.pendingText })] };

const flushReasoning = (acc: AssistantContentAcc): AssistantContentAcc =>
	acc.pendingReasoning.length === 0
		? acc
		: {
				...acc,
				pendingReasoning: "",
				parts: [...acc.parts, Prompt.makePart("reasoning", { text: acc.pendingReasoning })],
			};

/**
 * Flush BOTH pending accumulators. Used at any boundary part (text-start/-end,
 * reasoning-start/-end, tool-call/-result) so the arrival order of text vs
 * reasoning vs tool segments is preserved in the final `content` array.
 *
 * Cross-flushing on every boundary maintains the invariant that AT MOST one
 * of `pendingText` / `pendingReasoning` is non-empty between absorb calls.
 */
const flushAll = (acc: AssistantContentAcc): AssistantContentAcc => flushReasoning(flushText(acc));

const absorbPart = (acc: AssistantContentAcc, part: unknown): AssistantContentAcc => {
	if (!isRecord(part)) return acc;
	const tag = part.type;

	// Text boundaries flush BOTH accumulators (defensive — closes any prior
	// text or reasoning block before the new text block begins).
	if (tag === "text-start" || tag === "text-end") {
		return flushAll(acc);
	}

	// Text-delta: flush any pending reasoning FIRST (preserves the
	// reasoning→text arrival order if no explicit boundary fired between
	// them), then append to pending text.
	if (tag === "text-delta" && typeof part.delta === "string") {
		const flushed = flushReasoning(acc);
		return { ...flushed, pendingText: flushed.pendingText + part.delta };
	}

	// Reasoning boundaries flush BOTH accumulators (mirror of text-start/-end).
	if (tag === "reasoning-start" || tag === "reasoning-end") {
		return flushAll(acc);
	}

	// Reasoning-delta: cross-flush text first, then append to pending reasoning.
	if (tag === "reasoning-delta" && typeof part.delta === "string") {
		const flushed = flushText(acc);
		return { ...flushed, pendingReasoning: flushed.pendingReasoning + part.delta };
	}

	if (tag === "tool-call") {
		// Mirror liftPart's defensive guard: a malformed tool-call (missing
		// string id/name) is skipped rather than written to history as a
		// part `Prompt.make` would reject at the post-stream append.
		if (!hasStringProperty(part, "id") || !hasStringProperty(part, "name")) {
			return acc;
		}
		const flushed = flushAll(acc);
		return {
			pendingText: "",
			pendingReasoning: "",
			parts: [
				...flushed.parts,
				Prompt.makePart("tool-call", {
					id: part.id,
					name: part.name,
					params: part.params,
					providerExecuted: false,
				}),
			],
		};
	}

	if (tag === "tool-result") {
		// Mirror liftPart's defensive guard: a malformed tool-result is
		// skipped rather than written to history as a part `Prompt.make`
		// would reject at the post-stream append.
		if (!hasStringProperty(part, "id") || !hasStringProperty(part, "name") || typeof part.isFailure !== "boolean") {
			return acc;
		}
		const flushed = flushAll(acc);
		return {
			pendingText: "",
			pendingReasoning: "",
			parts: [
				...flushed.parts,
				Prompt.makePart("tool-result", {
					id: part.id,
					name: part.name,
					isFailure: part.isFailure,
					result: part.result,
				}),
			],
		};
	}

	// Skip streaming-only artifacts (`tool-params-*`, `response-metadata`,
	// `finish`, etc.) — they're event-only, not persisted.
	return acc;
};

const finalize = (acc: AssistantContentAcc): ReadonlyArray<Prompt.AssistantMessagePart> => flushAll(acc).parts;

/**
 * Captured per-send token totals. `null` means we never saw a `finish` part
 * (e.g. the stream errored or was interrupted before completion); the trailing
 * `Finish` event then omits the token fields and state totals are unchanged.
 */
interface CapturedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

/**
 * Read `usage.inputTokens.total` / `usage.outputTokens.total` off a `finish`
 * part. Undefined totals collapse to 0 so callers see a `number` everywhere.
 * Returns `null` for any non-`finish` part so the `Stream.tap` can no-op.
 */
const captureUsage = (part: unknown): CapturedUsage | null => {
	if (!isRecord(part)) return null;
	if (part.type !== "finish") return null;
	const usage = isRecord(part.usage) ? part.usage : undefined;
	const inputTokens = readTokenTotal(usage?.inputTokens);
	const outputTokens = readTokenTotal(usage?.outputTokens);
	return { inputTokens, outputTokens };
};

/**
 * Default transient-error retry cap when `SessionConfig.maxLlmRetries` is
 * omitted. With the default, a persistently-retryable failure gets 4 total
 * tries (initial + 3 retries) before the last error propagates. Slice 35
 * makes this per-session configurable via `SessionConfig.maxLlmRetries`.
 */
const MAX_LLM_RETRIES = 3;

const readTokenTotal = (value: unknown): number =>
	isRecord(value) && typeof value.total === "number" ? value.total : 0;

const isRetryableLlmError = (error: LlmError): boolean => isRecord(error.aiError) && error.aiError.isRetryable === true;

/**
 * Build the retry schedule for the per-attempt inner stream. Recurs up to
 * `maxRetries` times, AND halts early if the failing error is non-retryable
 * (per `AiError.reason.isRetryable`).
 *
 * The schedule's `input` is the stream's error type — here that's `LlmError`
 * (we map `AiError → LlmError` before the retry boundary so the schedule sees
 * pi's error shape). `maxRetries: 0` produces a schedule that never recurs,
 * so the single attempt's failure propagates immediately.
 */
const makeRetrySchedule = (maxRetries: number) =>
	Schedule.recurs(maxRetries).pipe(
		Schedule.while(({ input }: { readonly input: LlmError }) => isRetryableLlmError(input)),
	);

/**
 * Per-session configuration. Omitted fields fall back to the module defaults
 * (`COMPACTION_THRESHOLD` / `KEEP_RECENT_TOKENS` / `MAX_LLM_RETRIES`).
 */
export interface SessionConfig {
	/** Token estimate above which `Session.send` compacts history before the turn. */
	readonly compactionThreshold?: number;
	/** Tokens of recent history `splitHistory` keeps verbatim during compaction. */
	readonly keepRecentTokens?: number;
	/**
	 * Transient-error retry cap for the per-attempt LLM stream. Defaults to
	 * `MAX_LLM_RETRIES` (3); `0` disables retries entirely. Slice 35.
	 */
	readonly maxLlmRetries?: number;
}

/**
 * Build a new `Session`. The empty Session has empty history (`Prompt.empty`,
 * `turnCount: 0`). Each `send` call (a) bumps `turnCount` and appends the
 * new user prompt to history before opening the upstream stream, (b)
 * accumulates text deltas as the stream flows, and (c) appends the assembled
 * assistant message to history after the upstream completes.
 *
 * `Session.make(config?)` overrides the compaction defaults; `Session.empty`
 * is `Session.make({})` — the unconfigured session with module defaults.
 */
export const makeSession = (options: MakeOptions & SessionConfig): Effect.Effect<Session> =>
	Effect.gen(function* () {
		const compactionThreshold = options.compactionThreshold ?? COMPACTION_THRESHOLD;
		const keepRecentTokens = options.keepRecentTokens ?? KEEP_RECENT_TOKENS;
		const maxLlmRetries = options.maxLlmRetries ?? MAX_LLM_RETRIES;
		const state = yield* SubscriptionRef.make(options.initialState);
		return {
			state,
			send<OwnTools extends Record<string, Tool.Any> = {}>(
				input: string | Input,
				toolkit?: LanguageModel.ToolkitInput<OwnTools>,
				concurrency?: Types.Concurrency,
			) {
				// ADR-0009: tool execution defaults to sequential. The effect framework
				// defaults `concurrency` to `"unbounded"` when omitted, so resolve an
				// explicit `1` here unless the caller opted into parallelism.
				const resolvedConcurrency: Types.Concurrency = concurrency ?? 1;
				return Stream.unwrap(
					Effect.gen(function* () {
						const normalized = normalizeInput(input);

						// Observer hooks — read once per send. `Hooks` is a `Context.Reference`
						// with a no-op default, so this never adds to `send`'s `R` channel.
						const hooks = composeHooks(yield* Hooks);

						// Lifecycle hook: fired at stream open with the normalised input.
						// Observer-only — host code records turn metadata or pre-flight side
						// effects. Runs BEFORE history mutation / compaction / retry.
						yield* hooks.onStart(normalized);

						// 0. ONCE PER SEND — compute the next history depending on the input variant,
						//    then bump turnCount and commit the new history atomically. Runs
						//    BEFORE the compaction check (a) so `Retry`'s rollback drops the
						//    trailing assistant turn before we decide whether to summarise, and
						//    (b) so a fresh `NewPrompt` lands in `toKeep` (it is the most recent
						//    message). All runs OUTSIDE the retry boundary so transient-error
						//    retries do not re-bump `turnCount` or re-append the user message.
						//
						//    - NewPrompt: append a `user` message with the new prompt.
						//    - AcceptedPromptEnvelope: append host-preflighted injected messages,
						//      then the final user content, and optionally replace the system prompt.
						//    - Continue:  leave history as-is; the existing conversation IS the prompt.
						//    - Retry:     roll history back to the last `user` message (dropping the
						//                 trailing assistant turn), then proceed like Continue.
						const acceptedEnvelopePrompt =
							normalized._tag === "AcceptedPromptEnvelope"
								? yield* promptFromAcceptedEnvelope(normalized)
								: undefined;

						yield* SubscriptionRef.update(state, (s) => {
							const nextHistory = ((): Prompt.Prompt => {
								switch (normalized._tag) {
									case "NewPrompt":
										return Prompt.concat(s.history, normalized.prompt);
									case "AcceptedPromptEnvelope": {
										const withEnvelope = Prompt.concat(
											s.history,
											acceptedEnvelopePrompt ?? Prompt.empty,
										);
										return normalized.systemPromptOverride === undefined
											? withEnvelope
											: Prompt.setSystem(withEnvelope, normalized.systemPromptOverride);
									}
									case "Retry":
										return rollbackToLastUserMessage(s.history);
									default:
										return s.history;
								}
							})();
							return SessionState.advance(s, nextHistory);
						});
						const postInput = yield* SubscriptionRef.get(state);

						// Persist the turn bump before compaction opens its summary call.
						// If summary generation fails, durable sessions still reload the
						// accepted user turn instead of losing the partial turn entirely.
						yield* options.persist(postInput);

						// 1. COMPACTION CHECK — runs AFTER the input-variant update on the
						//    post-input history. When that history has grown past
						//    `COMPACTION_THRESHOLD`, summarise the older portion via
						//    `LanguageModel.generateText` and rebuild `state.history` as
						//    `[...systemMessages, summary user message, ...recent kept messages]`.
						//    The `CompactionApplied` event is prepended to the stream at the end
						//    of this `Effect.gen` so consumers see it as the first element.
						//
						//    **System messages survive compaction**: they are extracted from the
						//    history before `splitHistory` runs (so they are never fed into the
						//    summary call) and re-injected at the head of the compacted history
						//    so they keep their system-role placement.
						let compactionEvent: CompactionApplied | undefined;
						const tokensBefore = estimateTokens(postInput.history);
						if (tokensBefore > compactionThreshold) {
							const systemMessages = postInput.history.content.filter((m) => m.role === "system");
							const bodyHistory = Prompt.fromMessages(
								postInput.history.content.filter((m) => m.role !== "system"),
							);
							const { toSummarize, toKeep } = splitHistory(bodyHistory, keepRecentTokens);
							// A failed summarisation call surfaces as `CompactionError` in
							// `send`'s error channel — distinct from the per-turn `LlmError`.
							const summary = yield* LanguageModel.generateText({
								prompt: Prompt.concat(toSummarize, Prompt.make(SUMMARIZATION_INSTRUCTION)),
							}).pipe(Effect.mapError((aiError) => new CompactionError({ cause: aiError })));
							const compactedHistory = Prompt.fromMessages([
								...systemMessages,
								Prompt.makeMessage("user", {
									content: [Prompt.makePart("text", { text: summary.text })],
								}),
								...toKeep.content,
							]);
							yield* SubscriptionRef.update(state, (s) =>
								SessionState.with(s, {
									history: compactedHistory,
									compactionCount: s.compactionCount + 1,
								}),
							);
							compactionEvent = new CompactionApplied({
								tokensBefore,
								tokensAfter: estimateTokens(compactedHistory),
								summarizedMessageCount: toSummarize.content.length,
							});
						}

						const snapshot = yield* SubscriptionRef.get(state);

						// 1a. Persist the post-compaction snapshot only when compaction
						//     succeeded and changed state. The pre-compaction post-input
						//     snapshot was already persisted above so compaction failures
						//     preserve durable partial-turn state.
						if (compactionEvent !== undefined) {
							yield* options.persist(snapshot);
						}

						// 1b. Per-send attempt counter. Lives in the outer Effect.gen so the
						//     Stream.retry re-runs of the inner Effect.gen below all share it —
						//     attempt 1, 2, 3 each get a distinct `pi.attempt.number` attribute.
						const attemptCounter = yield* Ref.make(0);

						// 2. PER-ATTEMPT FACTORY — fresh Refs + fresh upstream open per try. The
						//    Stream.retry below re-runs this Effect.gen on each retryable failure,
						//    giving each attempt a clean accumulator (no leakage from partial
						//    events of a failed attempt).
						const attemptStream = Stream.unwrap(
							Effect.gen(function* () {
								// Bump the attempt counter and capture the value for this attempt's span.
								const attemptNumber = yield* Ref.updateAndGet(attemptCounter, (n) => n + 1);

								// Accumulator for the assistant's response — text deltas, tool calls,
								// and tool results in arrival order. Streaming-only artifacts skipped.
								const accRef = yield* Ref.make<AssistantContentAcc>(initialAcc);

								// Per-attempt usage capture. Stays null until a `finish` part lands;
								// if the attempt ends without one (errored / interrupted upstream),
								// the trailing `Finish` event omits token fields and state totals
								// don't bump.
								const usageRef = yield* Ref.make<CapturedUsage | null>(null);

								// Open the upstream stream with the FULL history (incl. just-appended user msg).
								// `concurrency` controls tool-call resolution parallelism (sequential
								// by default per ADR-0009; see `resolvedConcurrency` above).
								const upstream =
									toolkit === undefined
										? LanguageModel.streamText({
												prompt: snapshot.history,
												concurrency: resolvedConcurrency,
											})
										: LanguageModel.streamText({
												prompt: snapshot.history,
												toolkit,
												concurrency: resolvedConcurrency,
											});

								return upstream.pipe(
									Stream.flatMap((part) => Stream.fromIterable(liftPart(part))),
									// Absorb each LlmPart into the assistant-content accumulator. Skips
									// streaming-only artifacts; coalesces text deltas; captures tool turns.
									// Also peels usage totals off the upstream `finish` part into usageRef.
									Stream.tap((event) =>
										event._tag === "LlmPart"
											? Effect.gen(function* () {
													yield* Ref.update(accRef, (acc) => absorbPart(acc, event.part));
													const captured = captureUsage(event.part);
													if (captured !== null) {
														yield* Ref.set(usageRef, captured);
													}
												})
											: Effect.void,
									),
									// Map BEFORE the retry boundary so the schedule's predicate sees `LlmError`.
									Stream.mapError((aiError): LlmError => new LlmError({ aiError })),
									// After the upstream completes, append the assistant message (with
									// text + tool-call + tool-result content in order), bump cumulative
									// token totals on state, and emit Finish carrying this send's tokens.
									// On a failed attempt this concat never runs (Stream.concat skips
									// when the left side errors), so partial accumulator state never
									// leaks into `state.history`.
									Stream.concat(
										Stream.unwrap(
											Effect.gen(function* () {
												const acc = yield* Ref.get(accRef);
												const content = finalize(acc);
												const usage = yield* Ref.get(usageRef);
												if (content.length > 0 || usage !== null) {
													yield* SubscriptionRef.update(state, (s) => {
														const nextHistory =
															content.length > 0
																? Prompt.concat(
																		s.history,
																		Prompt.fromMessages([
																			Prompt.makeMessage("assistant", { content }),
																		]),
																	)
																: s.history;
														return SessionState.with(s, {
															history: nextHistory,
															inputTokens: s.inputTokens + (usage?.inputTokens ?? 0),
															outputTokens: s.outputTokens + (usage?.outputTokens ?? 0),
														});
													});
												}
												return Stream.succeed<AgentEvent>(
													usage === null
														? new Finish({})
														: new Finish({
																inputTokens: usage.inputTokens,
																outputTokens: usage.outputTokens,
															}),
												);
											}),
										),
									),
									// Per-attempt telemetry span. Wraps the entire attempt pipeline:
									// flatMap + tap + mapError + concat. The span ends when the attempt
									// completes (success / any failure / interruption). On retry, a new
									// attemptStream open re-enters this Effect.gen, bumps the counter,
									// and emits a fresh sibling span under the outer `pi.Session.send`
									// span — so consumers see one attempt span per try.
									Stream.withSpan("pi.Session.send.attempt", {
										attributes: { "pi.attempt.number": attemptNumber },
									}),
								);
							}),
						);

						// 3. Wrap the per-attempt stream with a retry schedule + an outer
						//    telemetry span. Bounded recurs + while-isRetryable predicate stops
						//    early on AuthenticationError / InvalidRequestError / etc., and caps
						//    the loop at `maxLlmRetries` (default `MAX_LLM_RETRIES`, configurable
						//    via `SessionConfig.maxLlmRetries`). The outer span wraps the whole
						//    send (including all retries) so consumers see a parent span with N
						//    attempt-span children.
						const mainStream = attemptStream.pipe(
							Stream.retry(makeRetrySchedule(maxLlmRetries)),
							Stream.withSpan("pi.Session.send", {
								attributes: {
									"pi.input.tag": normalized._tag,
									"pi.history.size": snapshot.history.content.length,
								},
							}),
						);

						// Prepend the `CompactionApplied` event when compaction fired at the
						// top of this send, so consumers observe it as the first element.
						const fullStream =
							compactionEvent === undefined
								? mainStream
								: Stream.concat(Stream.succeed<AgentEvent>(compactionEvent), mainStream);

						// Observer hooks (ADR-0009): invoke `onAgentEvent` for every event the
						// consumer sees, in stream order; fire `onShutdown(exit)` once when
						// the stream completes (success / failure / interrupt — `Stream.onExit`
						// covers all three and threads the typed `Exit` to the hook). The
						// `Hooks` reference defaults to no-ops, so this is inert unless a host
						// / extension / test provides one.
						return fullStream.pipe(
							Stream.tap((event) => hooks.onAgentEvent(event)),
							Stream.onExit((exit) => hooks.onShutdown(exit)),
						);
					}),
				);
			},
		} satisfies Session;
	});

/**
 * `Session.durable(id)` loads/persists `SessionState` through `SessionStore`.
 * Each load resolves the previous snapshot (or `SessionState.empty` for a new
 * id) and every `send` persists the post-bump snapshot back to the store.
 */
export const durable = (sessionId: string): Effect.Effect<Session, AgentError, SessionStore> =>
	Effect.gen(function* () {
		const store = yield* SessionStore;
		const stored = yield* store.load(sessionId);
		return yield* makeSession({
			initialState: Option.getOrElse(stored, () => SessionState.empty),
			persist: (state) => store.save(sessionId, state),
		});
	});

/**
 * `Session.make(config?)` builds a non-durable session with optional
 * per-session compaction config; `Session.empty` is the unconfigured session
 * (`Session.make({})`) — module defaults for compaction, no-op `persist`.
 * `Session.durable(id)` is the `SessionStore`-backed variant. All three are
 * `Effect`s that produce a FRESH `Session` (with its own `state`
 * `SubscriptionRef`) each time they are run.
 */
export const Session: {
	readonly empty: Effect.Effect<Session>;
	readonly make: (config?: SessionConfig) => Effect.Effect<Session>;
	readonly durable: typeof durable;
} = {
	make: (config: SessionConfig = {}) =>
		makeSession({ initialState: SessionState.empty, persist: () => Effect.void, ...config }),
	empty: makeSession({ initialState: SessionState.empty, persist: () => Effect.void }),
	durable,
};
