/**
 * `Session` is the public ADR-0009 entry point for the pi agent loop on
 * Effect v4. The current slice:
 *
 * ```ts
 * const session = yield* Session.empty
 * const events = yield* Stream.runCollect(session.send("hello"))
 * ```
 *
 * `send(prompt)` returns a `Stream<AgentEvent, AgentError, LanguageModel.LanguageModel>`:
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
 * - **Each `send` call increments `state.turnCount` by 1**, atomically, before
 *   the upstream stream starts emitting. Observers subscribed to
 *   `session.state` see the bump on the same fiber boundary the new events
 *   arrive.
 *
 * `session.state: SubscriptionRef<SessionState>` exposes the observable
 * snapshot per ADR-0009. Components can read snapshots via
 * `SubscriptionRef.get(state)` or subscribe to changes via
 * `SubscriptionRef.changes(state)`. The first slice carries only `turnCount`.
 *
 * `send` accepts an optional second `toolkit` argument that is forwarded to
 * `LanguageModel.streamText({ prompt, toolkit })`. When provided, the upstream
 * provider dispatches `function_call` events; the resulting `tool-call` /
 * `tool-result` parts surface via the `liftPart` flatMap as `ToolDispatched` /
 * `ToolCompleted` events. Handler resolution services come from the runtime
 * context (via `toolkit.toLayer({ ToolName: handler })`), NOT from this
 * signature's R-type.
 *
 * Deferred to follow-on slices (each becomes its own tracer bullet):
 *
 * - The `Input = NewPrompt | Continue | Retry` discriminated union (`send`
 *   currently takes a bare prompt string).
 * - Multi-turn history (the message log inside `SessionState`).
 * - Token / cost accounting on `Finish` and inside `SessionState`.
 * - Compaction triggers, retry on transient errors, skill-block parsing,
 *   `Effect.withSpan` telemetry -- the wrapping per ADR-0009.
 */
import { Effect, Option, Stream, SubscriptionRef } from "effect";
import { LanguageModel, type Tool } from "effect/unstable/ai";

import { type AgentError, LlmError } from "./agent-error.js";
import { type AgentEvent, Finish, LlmPart, ToolCompleted, ToolDispatched } from "./agent-event.js";
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
 * `WeatherHandlers` Layer at the use site), NOT in this signature's R-type —
 * keeping the public surface stable regardless of which toolkit shape is
 * passed.
 */
export interface Session {
	readonly state: SubscriptionRef.SubscriptionRef<SessionState>;
	readonly send: <Tools extends Record<string, Tool.Any> = {}>(
		prompt: string,
		toolkit?: LanguageModel.ToolkitInput<Tools>,
	) => Stream.Stream<AgentEvent, AgentError, LanguageModel.LanguageModel>;
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

const streamPrompt = <Tools extends Record<string, Tool.Any>>(
	prompt: string,
	toolkit: LanguageModel.ToolkitInput<Tools> | undefined,
) =>
	toolkit === undefined
		? LanguageModel.streamText({ prompt })
		: LanguageModel.streamText<
				Tools,
				{ readonly prompt: string; readonly toolkit: LanguageModel.ToolkitInput<Tools> }
			>({ prompt, toolkit });

/**
 * Build a new `Session`. The empty Session has no history, but the `state`
 * SubscriptionRef is live -- every `send` call increments `turnCount` so
 * observers can react to turn boundaries.
 */
export const makeSession = (options: MakeOptions): Effect.Effect<Session> =>
	Effect.gen(function* () {
		const state = yield* SubscriptionRef.make(options.initialState);
		return {
			state,
			send: <Tools extends Record<string, Tool.Any> = {}>(
				prompt: string,
				toolkit?: LanguageModel.ToolkitInput<Tools>,
			) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const nextState = yield* SubscriptionRef.modify(state, (s) => {
							const next = new SessionState({ turnCount: s.turnCount + 1 });
							const result: readonly [SessionState, SessionState] = [next, next];
							return result;
						});
						yield* options.persist(nextState);
						const upstream = streamPrompt(prompt, toolkit);
						return upstream.pipe(
							Stream.flatMap((part) => Stream.fromIterable(liftPart(part))),
							Stream.mapError((aiError): LlmError => new LlmError({ aiError })),
							Stream.concat(Stream.succeed<AgentEvent>(new Finish({}))),
						);
					}),
				),
		} satisfies Session;
	});

export const durable = (sessionId: string): Effect.Effect<Session, AgentError, SessionStore> =>
	Effect.gen(function* () {
		const store = yield* SessionStore;
		const stored = yield* store.load(sessionId);
		return yield* makeSession({
			initialState: Option.getOrElse(stored, () => SessionState.empty),
			persist: (state) => store.save(sessionId, state),
		});
	});

export const Session: {
	readonly empty: Effect.Effect<Session>;
	readonly durable: typeof durable;
} = {
	empty: makeSession({
		initialState: SessionState.empty,
		persist: () => Effect.void,
	}),
	durable,
};
