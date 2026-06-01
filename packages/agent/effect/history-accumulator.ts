import { hasStringProperty, isRecord } from "./type-guards.js";

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
export interface AssistantContentAcc {
	readonly pendingText: string;
	readonly pendingReasoning: string;
	readonly parts: ReadonlyArray<Record<string, unknown>>;
}

export const initialAcc: AssistantContentAcc = { pendingText: "", pendingReasoning: "", parts: [] };

const flushText = (acc: AssistantContentAcc): AssistantContentAcc =>
	acc.pendingText.length === 0
		? acc
		: { ...acc, pendingText: "", parts: [...acc.parts, { type: "text", text: acc.pendingText }] };

const flushReasoning = (acc: AssistantContentAcc): AssistantContentAcc =>
	acc.pendingReasoning.length === 0
		? acc
		: { ...acc, pendingReasoning: "", parts: [...acc.parts, { type: "reasoning", text: acc.pendingReasoning }] };

/**
 * Flush BOTH pending accumulators. Used at any boundary part (text-start/-end,
 * reasoning-start/-end, tool-call/-result) so the arrival order of text vs
 * reasoning vs tool segments is preserved in the final `content` array.
 *
 * Cross-flushing on every boundary maintains the invariant that AT MOST one
 * of `pendingText` / `pendingReasoning` is non-empty between accumulate calls.
 */
const flushAll = (acc: AssistantContentAcc): AssistantContentAcc => flushReasoning(flushText(acc));

/**
 * Fold one upstream part into the accumulator. Renamed from `absorbPart` for
 * clarity — the function accumulates the part's contribution into history-
 * shaped content; streaming-only artifacts (tool-params-*, response-metadata,
 * finish) are skipped.
 */
export const accumulatePart = (acc: AssistantContentAcc, part: unknown): AssistantContentAcc => {
	if (!isRecord(part)) return acc;
	const p = part as { readonly type?: unknown; readonly delta?: unknown };

	// Text boundaries flush BOTH accumulators (defensive — closes any prior
	// text or reasoning block before the new text block begins).
	if (p.type === "text-start" || p.type === "text-end") {
		return flushAll(acc);
	}

	// Text-delta: flush any pending reasoning FIRST (preserves the
	// reasoning→text arrival order if no explicit boundary fired between
	// them), then append to pending text.
	if (p.type === "text-delta" && typeof p.delta === "string") {
		const flushed = flushReasoning(acc);
		return { ...flushed, pendingText: flushed.pendingText + p.delta };
	}

	// Reasoning boundaries flush BOTH accumulators (mirror of text-start/-end).
	if (p.type === "reasoning-start" || p.type === "reasoning-end") {
		return flushAll(acc);
	}

	// Reasoning-delta: cross-flush text first, then append to pending reasoning.
	if (p.type === "reasoning-delta" && typeof p.delta === "string") {
		const flushed = flushText(acc);
		return { ...flushed, pendingReasoning: flushed.pendingReasoning + p.delta };
	}

	if (p.type === "tool-call") {
		// Mirror lift-part's defensive guard: a malformed tool-call (missing
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
				{ type: "tool-call", id: part.id, name: part.name, params: part.params, providerExecuted: false },
			],
		};
	}

	if (p.type === "tool-result") {
		// Mirror lift-part's defensive guard: a malformed tool-result is
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
				{ type: "tool-result", id: part.id, name: part.name, isFailure: part.isFailure, result: part.result },
			],
		};
	}

	// Skip streaming-only artifacts (`tool-params-*`, `response-metadata`,
	// `finish`, etc.) — they're event-only, not persisted.
	return acc;
};

export const finalize = (acc: AssistantContentAcc): ReadonlyArray<Record<string, unknown>> => flushAll(acc).parts;
