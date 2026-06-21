import { Effect, SubscriptionRef } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";

import { type AgentError, CompactionError } from "./agent-error.js";
import { CompactionApplied } from "./agent-event.js";
import { estimateTokens, splitHistory } from "./compaction.js";
import { SessionState } from "./session-state.js";

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
 * permanently lost from the long-term session state (the load-bearing-facts
 * fix grafted from PR #10 / ADR-0019). Empty sections are omitted by the model
 * rather than padded.
 */
export const SUMMARIZATION_INSTRUCTION =
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
 * Result of a fired compaction: the event for the per-send stream plus the
 * true post-commit snapshot (from `SubscriptionRef.updateAndGet`), so the
 * caller needs no re-get after the step.
 */
export interface CompactionStepResult {
	readonly event: CompactionApplied;
	readonly state: SessionState;
}

/**
 * Step 1 of `Session.send`: compaction check, run AFTER the input-variant
 * history update on the post-input history.
 *
 * When the history has grown past `compactionThreshold`, summarise the older
 * portion via `LanguageModel.generateText` and rebuild `state.history` as
 * `[...systemMessages, summary user message, ...recent kept messages]`. The
 * returned `CompactionApplied` event is meant to be prepended to the per-send
 * stream so consumers observe it as the first element.
 *
 * **System messages survive compaction**: they are extracted from the
 * history before `splitHistory` runs (so they are never fed into the
 * summary call) and re-injected at the head of the compacted history so
 * they keep their system-role placement.
 *
 * **Commit + persist are one uninterruptible section** (PI-EFX-04): the
 * `SubscriptionRef.updateAndGet` commit and the `options.persist` write are
 * shielded via `Effect.uninterruptibleMask` so an interrupt cannot split the
 * in-memory compacted state from its durable write. The slow summary call
 * stays interruptible via `restore`.
 *
 * A failed summarisation call surfaces as `CompactionError` in the caller's
 * error channel — distinct from the per-turn `LlmError`.
 */
export const runCompactionStep = (
	state: SubscriptionRef.SubscriptionRef<SessionState>,
	postInput: SessionState,
	options: {
		readonly compactionThreshold: number;
		readonly keepRecentTokens: number;
		readonly persist: (state: SessionState) => Effect.Effect<void, AgentError>;
	},
): Effect.Effect<CompactionStepResult | undefined, AgentError, LanguageModel.LanguageModel> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const tokensBefore = estimateTokens(postInput.history);
			if (tokensBefore <= options.compactionThreshold) {
				return undefined;
			}

			const systemMessages = postInput.history.content.filter((m) => m.role === "system");
			const bodyHistory = Prompt.fromMessages(postInput.history.content.filter((m) => m.role !== "system"));
			const { toSummarize, toKeep } = splitHistory(bodyHistory, options.keepRecentTokens);

			const summary = yield* restore(
				LanguageModel.generateText({
					prompt: Prompt.concat(toSummarize, Prompt.make(SUMMARIZATION_INSTRUCTION)),
				}).pipe(Effect.mapError((aiError) => new CompactionError({ cause: aiError }))),
			);

			const compactedHistory = Prompt.fromMessages([
				...systemMessages,
				Prompt.makeMessage("user", {
					content: [Prompt.makePart("text", { text: summary.text })],
				}),
				...toKeep.content,
			]);
			const compacted = yield* SubscriptionRef.updateAndGet(state, (s) =>
				SessionState.with(s, {
					history: compactedHistory,
					compactionCount: s.compactionCount + 1,
				}),
			);
			yield* options.persist(compacted);
			return {
				event: new CompactionApplied({
					tokensBefore,
					tokensAfter: estimateTokens(compactedHistory),
					summarizedMessageCount: toSummarize.content.length,
				}),
				state: compacted,
			};
		}),
	);
