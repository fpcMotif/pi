/**
 * Public ADR-0009 agent-loop entry point. `Session.send` owns turn setup,
 * durable persistence, retry/span/hook orchestration, and delegates provider
 * part processing plus compaction to focused helpers.
 */
import { Effect, Option, Ref, Stream, SubscriptionRef, type Types } from "effect";
import { LanguageModel, Prompt, type Tool } from "effect/unstable/ai";

import { type AgentError, LlmError } from "./agent-error.js";
import { type AgentEvent } from "./agent-event.js";
import {
	type Input,
	normalize as normalizeInput,
	promptFromAcceptedEnvelope,
	rollbackToLastUserMessage,
} from "./agent-input.js";
import { composeHooks, Hooks } from "./hooks.js";
import { COMPACTION_THRESHOLD, KEEP_RECENT_TOKENS } from "./compaction.js";
import { compactIfNeeded } from "./session-compaction.js";
import {
	applyLlmPartToAttemptState,
	type AssistantContentAcc,
	type CapturedUsage,
	finalizeAssistantContent,
	initialAssistantContentAcc,
	liftPart,
	makeFinishEvent,
} from "./session-parts.js";
import { MAX_LLM_RETRIES, makeRetrySchedule } from "./session-retry.js";
import { SessionState } from "./session-state.js";
import { SessionStore } from "./stores/session-store.js";

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
								: Prompt.empty;

						yield* SubscriptionRef.update(state, (s) => {
							const nextHistory = ((): Prompt.Prompt => {
								switch (normalized._tag) {
									case "NewPrompt":
										return Prompt.concat(s.history, normalized.prompt);
									case "AcceptedPromptEnvelope": {
										const withEnvelope = Prompt.concat(s.history, acceptedEnvelopePrompt);
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

						const { event: compactionEvent, snapshot } = yield* compactIfNeeded(state, {
							threshold: compactionThreshold,
							keepRecentTokens,
						});

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
								const accRef = yield* Ref.make<AssistantContentAcc>(initialAssistantContentAcc);

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
													yield* applyLlmPartToAttemptState(accRef, usageRef, event.part);
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
												const content = finalizeAssistantContent(acc);
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
												return Stream.succeed<AgentEvent>(makeFinishEvent(usage));
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
