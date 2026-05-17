/**
 * Compaction triggers for the `Session.send` loop (slice 28, ADR-0009).
 *
 * Pure helpers — no Effect, no runtime — so the trigger logic is unit-testable
 * in isolation. `Session.send` wires them in: before opening the upstream
 * stream it checks `shouldCompact(state.history)`, and if so summarises the
 * older portion (via `LanguageModel.generateText`) and rebuilds history.
 */
import { Prompt } from "effect/unstable/ai";

/**
 * Character count of one message's text content. The chars/4 token heuristic
 * is applied by the callers (`estimateTokens`, `splitHistory`) so rounding
 * happens once per aggregate rather than per message.
 */
const jsonChars = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

const fileDataChars = (data: string | Uint8Array | URL): number => {
	if (typeof data === "string") return data.length;
	if (data instanceof Uint8Array) return data.byteLength;
	return data.toString().length;
};

const messageChars = (message: Prompt.Message): number => {
	if (typeof message.content === "string") {
		return message.content.length;
	}

	let chars = 0;
	for (const part of message.content) {
		switch (part.type) {
			case "text":
			case "reasoning":
				chars += part.text.length;
				break;
			case "file":
				chars += part.mediaType.length + (part.fileName?.length ?? 0) + fileDataChars(part.data);
				break;
			case "tool-call":
				chars += part.id.length + part.name.length + jsonChars(part.params);
				break;
			case "tool-result":
				chars += part.id.length + part.name.length + jsonChars(part.result);
				break;
			case "tool-approval-request":
				chars += part.approvalId.length + part.toolCallId.length;
				break;
			case "tool-approval-response":
				chars += part.approvalId.length + String(part.approved).length + (part.reason?.length ?? 0);
				break;
		}
	}
	return chars;
};

/**
 * Estimate the token cost of a `Prompt` using a chars/4 heuristic over its
 * message text content. Conservative (overestimates); mirrors the legacy
 * `estimateTokens` fallback path in `src/harness/compaction/compaction.ts`.
 */
export const estimateTokens = (history: Prompt.Prompt): number => {
	let chars = 0;
	for (const message of history.content) {
		chars += messageChars(message);
	}
	return Math.ceil(chars / 4);
};

/**
 * Trigger predicate: `true` once the estimated token cost of `history` exceeds
 * `threshold`. At or below the threshold compaction is skipped.
 */
export const shouldCompact = (history: Prompt.Prompt, threshold: number): boolean =>
	estimateTokens(history) > threshold;

/**
 * Slice-28 default: compaction triggers once `estimateTokens(history)` exceeds
 * this many tokens. Hardcoded for now — a configurable policy on
 * `Session.empty` is a follow-on slice (same disposition as `MAX_LLM_RETRIES`).
 */
export const COMPACTION_THRESHOLD = 100_000;

/**
 * Slice-28 default: how many tokens of recent history `splitHistory` keeps
 * verbatim. Mirrors the legacy `keepRecentTokens: 20000` default.
 */
export const KEEP_RECENT_TOKENS = 20_000;

/**
 * The result of cutting `history` into the older portion to summarise and the
 * recent portion to keep verbatim.
 */
export interface HistorySplit {
	readonly toSummarize: Prompt.Prompt;
	readonly toKeep: Prompt.Prompt;
}

/**
 * Find the cut point that keeps approximately `keepRecentTokens` of the most
 * recent messages. Walks backwards from the newest message accumulating the
 * chars/4 estimate; the first message that tips the accumulator at or past
 * `keepRecentTokens` becomes the start of `toKeep`. Everything older lands in
 * `toSummarize`.
 *
 * If the whole history is smaller than `keepRecentTokens` there is nothing to
 * summarise: `toSummarize` is empty and `toKeep` is the full history.
 *
 * The cut never lands on a `tool` message: a tool-result must stay with the
 * `assistant` message that issued its tool-call, so the cut walks back past
 * any leading `tool` messages.
 */
export const splitHistory = (history: Prompt.Prompt, keepRecentTokens: number): HistorySplit => {
	const messages = history.content;
	let accumulatedChars = 0;
	let cutIndex = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		accumulatedChars += messageChars(messages[i]);
		if (Math.ceil(accumulatedChars / 4) >= keepRecentTokens) {
			cutIndex = i;
			break;
		}
	}
	// Never orphan a tool-result from its tool-call: if the cut lands on a
	// `tool` message, walk back to the preceding non-`tool` message.
	while (cutIndex > 0 && messages[cutIndex].role === "tool") {
		cutIndex--;
	}
	return {
		toSummarize: Prompt.fromMessages(messages.slice(0, cutIndex)),
		toKeep: Prompt.fromMessages(messages.slice(cutIndex)),
	};
};
