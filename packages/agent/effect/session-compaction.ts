import { Effect, SubscriptionRef } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";

import { CompactionError } from "./agent-error.js";
import { CompactionApplied } from "./agent-event.js";
import { estimateTokens, shouldCompact, splitHistory } from "./compaction.js";
import { SessionState } from "./session-state.js";

export const SUMMARIZATION_INSTRUCTION =
	"Summarize the conversation above into a structured context checkpoint that another assistant can load to continue the work. Preserve exact file paths, function names, error messages, and any constraints or blockers verbatim - the conversation prefix being summarised will be DISCARDED, so anything not captured here is lost. Use the following markdown sections, omitting any that would be empty:\n\n" +
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

export interface SessionCompactionOptions {
	readonly threshold: number;
	readonly keepRecentTokens: number;
}

export interface SessionCompactionResult {
	readonly snapshot: SessionState;
	readonly event: CompactionApplied | undefined;
}

export const compactIfNeeded = (
	state: SubscriptionRef.SubscriptionRef<SessionState>,
	options: SessionCompactionOptions,
): Effect.Effect<SessionCompactionResult, CompactionError, LanguageModel.LanguageModel> =>
	Effect.gen(function* () {
		const current = yield* SubscriptionRef.get(state);
		const tokensBefore = estimateTokens(current.history);
		if (!shouldCompact(current.history, options.threshold)) {
			return { snapshot: current, event: undefined } satisfies SessionCompactionResult;
		}

		const systemMessages = current.history.content.filter((message) => message.role === "system");
		const bodyHistory = Prompt.fromMessages(current.history.content.filter((message) => message.role !== "system"));
		const { toSummarize, toKeep } = splitHistory(bodyHistory, options.keepRecentTokens);
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

		yield* SubscriptionRef.update(state, (sessionState) =>
			SessionState.with(sessionState, {
				history: compactedHistory,
				compactionCount: sessionState.compactionCount + 1,
			}),
		);

		return {
			snapshot: yield* SubscriptionRef.get(state),
			event: new CompactionApplied({
				tokensBefore,
				tokensAfter: estimateTokens(compactedHistory),
				summarizedMessageCount: toSummarize.content.length,
			}),
		} satisfies SessionCompactionResult;
	});
