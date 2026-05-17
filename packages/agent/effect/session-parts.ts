import { Effect, Ref, SubscriptionRef } from "effect";
import { Prompt } from "effect/unstable/ai";

import { type AgentEvent, Finish, LlmPart, ToolCompleted, ToolDispatched } from "./agent-event.js";
import { SessionState } from "./session-state.js";

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;

const hasStringProperty = <Key extends PropertyKey>(
	value: Record<PropertyKey, unknown>,
	key: Key,
): value is Record<Key, string> & Record<PropertyKey, unknown> => typeof value[key] === "string";

export const liftPart = (part: unknown): ReadonlyArray<AgentEvent> => {
	const base = new LlmPart({ part });
	if (!isRecord(part)) return [base];

	if (part.type === "tool-call" && hasStringProperty(part, "id") && hasStringProperty(part, "name")) {
		return [base, new ToolDispatched({ toolName: part.name, toolCallId: part.id, params: part.params })];
	}

	if (
		part.type === "tool-result" &&
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

export interface AssistantContentAcc {
	readonly pendingText: string;
	readonly pendingReasoning: string;
	readonly parts: ReadonlyArray<Prompt.AssistantMessagePart>;
}

export const initialAssistantContentAcc: AssistantContentAcc = { pendingText: "", pendingReasoning: "", parts: [] };

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

const flushAll = (acc: AssistantContentAcc): AssistantContentAcc => flushReasoning(flushText(acc));

export const absorbPart = (acc: AssistantContentAcc, part: unknown): AssistantContentAcc => {
	if (!isRecord(part)) return acc;

	if (part.type === "text-start" || part.type === "text-end") {
		return flushAll(acc);
	}

	if (part.type === "text-delta" && typeof part.delta === "string") {
		const flushed = flushReasoning(acc);
		return { ...flushed, pendingText: flushed.pendingText + part.delta };
	}

	if (part.type === "reasoning-start" || part.type === "reasoning-end") {
		return flushAll(acc);
	}

	if (part.type === "reasoning-delta" && typeof part.delta === "string") {
		const flushed = flushText(acc);
		return { ...flushed, pendingReasoning: flushed.pendingReasoning + part.delta };
	}

	if (part.type === "tool-call") {
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

	if (part.type === "tool-result") {
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

	return acc;
};

export const finalizeAssistantContent = (acc: AssistantContentAcc): ReadonlyArray<Prompt.AssistantMessagePart> =>
	flushAll(acc).parts;

export interface CapturedUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

const readTokenTotal = (value: unknown): number =>
	isRecord(value) && typeof value.total === "number" ? value.total : 0;

export const captureUsage = (part: unknown): CapturedUsage | null => {
	if (!isRecord(part) || part.type !== "finish") return null;
	const usage = isRecord(part.usage) ? part.usage : undefined;
	return {
		inputTokens: readTokenTotal(usage?.inputTokens),
		outputTokens: readTokenTotal(usage?.outputTokens),
	};
};

export const makeFinishEvent = (usage: CapturedUsage | null): Finish =>
	usage === null ? new Finish({}) : new Finish({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

export const applyLlmPartToAttemptState = (
	accRef: Ref.Ref<AssistantContentAcc>,
	usageRef: Ref.Ref<CapturedUsage | null>,
	part: unknown,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Ref.update(accRef, (acc) => absorbPart(acc, part));
		const captured = captureUsage(part);
		if (captured !== null) {
			yield* Ref.set(usageRef, captured);
		}
	});

/**
 * Close out a `Session.send` attempt: drain the assistant-content accumulator
 * into a single history-bound `assistant` message, fold the captured usage
 * totals into `SessionState`, and produce the trailing {@link Finish} event.
 *
 * Skips the history update when the attempt produced neither content nor a
 * `finish` part (errored / interrupted upstream) — `state.history` only gains
 * an assistant message when there is something to record. The returned
 * `Finish` carries this attempt's tokens (omitted when no usage was captured).
 */
export const commitAssistantTurn = (
	state: SubscriptionRef.SubscriptionRef<SessionState>,
	accRef: Ref.Ref<AssistantContentAcc>,
	usageRef: Ref.Ref<CapturedUsage | null>,
): Effect.Effect<AgentEvent> =>
	Effect.gen(function* () {
		const acc = yield* Ref.get(accRef);
		const content = finalizeAssistantContent(acc);
		const usage = yield* Ref.get(usageRef);
		if (content.length > 0 || usage !== null) {
			yield* SubscriptionRef.update(state, (sessionState) => {
				const nextHistory =
					content.length > 0
						? Prompt.concat(
								sessionState.history,
								Prompt.fromMessages([Prompt.makeMessage("assistant", { content })]),
							)
						: sessionState.history;
				return SessionState.with(sessionState, {
					history: nextHistory,
					inputTokens: sessionState.inputTokens + (usage?.inputTokens ?? 0),
					outputTokens: sessionState.outputTokens + (usage?.outputTokens ?? 0),
				});
			});
		}
		return makeFinishEvent(usage);
	});
