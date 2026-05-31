/**
 * Tracer bullets for slice 28 — compaction triggers wired into `Session.send`
 * (ADR-0009 "wrapping").
 *
 * Before opening the upstream stream, `Session.send` checks
 * `shouldCompact(state.history, COMPACTION_THRESHOLD)`. When over threshold it
 * summarises the older portion via `LanguageModel.generateText`, rebuilds
 * `state.history` as `[summary user message, ...recent kept messages]`, and
 * emits a `CompactionApplied` event as the FIRST element of the stream.
 */
import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef } from "effect";
import { AiError, Prompt } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import { Retry } from "../../effect/agent-input.js";
import { COMPACTION_THRESHOLD, estimateTokens } from "../../effect/compaction.js";
import { Session } from "../../effect/session.js";
import { SessionState } from "../../effect/session-state.js";
import { recordingLanguageModelDual } from "../../test-support/recording-language-model-dual.js";
import { stubLanguageModelDual } from "../../test-support/stub-language-model-dual.js";
import { stubLanguageModelStream } from "../../test-support/stub-language-model-stream.js";

const streamParts = [
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "answer" },
	{ type: "text-end", id: "t1" },
];

describe("Session.send compaction triggers", () => {
	it.effect("over-threshold history: CompactionApplied is the first event and state.history shrinks", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			// Inflate history well past the threshold (~half user, half assistant).
			const halfChars = (COMPACTION_THRESHOLD + 5000) * 2;
			const bigHistory = Prompt.make([
				{ role: "user", content: "u".repeat(halfChars) },
				{ role: "assistant", content: [{ type: "text", text: "a".repeat(halfChars) }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 3,
					history: bigHistory,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			const events = yield* Stream.runCollect(session.send("next question"));

			expect(events[0]._tag).toBe("CompactionApplied");

			const after = yield* SubscriptionRef.get(session.state);
			expect(estimateTokens(after.history)).toBeLessThan(estimateTokens(bigHistory));
		}).pipe(
			Effect.provide(stubLanguageModelDual({ summaryText: "## Summary\nThe user asked things.", streamParts })),
		),
	);

	it.effect("under-threshold history: no CompactionApplied event, no summary call", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			const smallHistory = Prompt.make([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 1,
					history: smallHistory,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			const events = yield* Stream.runCollect(session.send("next question"));

			expect(events.some((e) => e._tag === "CompactionApplied")).toBe(false);
		}).pipe(
			// `stubLanguageModelStream` dies on `generateText` — so this also proves
			// the under-threshold path never reaches the summarisation call.
			Effect.provide(stubLanguageModelStream(streamParts)),
		),
	);

	it.effect("over-threshold history with a system message: the system message survives compaction", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			// System message first, then enough user+assistant bulk to trip the threshold.
			const halfChars = (COMPACTION_THRESHOLD + 5000) * 2;
			const bigHistory = Prompt.make([
				{ role: "system", content: "You are a specialised pi agent." },
				{ role: "user", content: "u".repeat(halfChars) },
				{ role: "assistant", content: [{ type: "text", text: "a".repeat(halfChars) }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 3,
					history: bigHistory,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			yield* Stream.runDrain(session.send("next question"));

			// The system message must still be present as a system-role message — not
			// folded into the summary's user text and not dropped entirely.
			const after = yield* SubscriptionRef.get(session.state);
			const system = after.history.content.find((m) => m.role === "system");
			expect(system).toBeDefined();
			expect((system as { readonly content: string }).content).toBe("You are a specialised pi agent.");
		}).pipe(
			Effect.provide(stubLanguageModelDual({ summaryText: "## Summary\nThe user asked things.", streamParts })),
		),
	);

	it.effect("Retry with huge trailing assistant content still sends the original user prompt", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			// The trailing assistant turn alone exceeds the compaction threshold. The
			// original user prompt is tiny. If compaction ran BEFORE the Retry rollback,
			// that user prompt would be folded into the summary and `Retry` would
			// re-send the synthetic summary message instead of the real prompt.
			const hugeChars = (COMPACTION_THRESHOLD + 5000) * 4;
			const history = Prompt.make([
				{ role: "user", content: "the original question" },
				{ role: "assistant", content: [{ type: "text", text: "a".repeat(hugeChars) }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 1,
					history,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			const recording = recordingLanguageModelDual({ summaryText: "## Summary", streamParts });
			yield* Stream.runDrain(session.send(new Retry({}))).pipe(Effect.provide(recording.layer));

			// The prompt handed to `streamText` must end with the ORIGINAL user
			// message, not a synthetic compaction-summary user message.
			const sentPrompt = recording.calls[0].prompt as {
				readonly content: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
			};
			const lastUser = [...sentPrompt.content].reverse().find((m) => m.role === "user");
			expect(lastUser).toBeDefined();
			const lastUserParts = lastUser?.content as ReadonlyArray<{ readonly type: string; readonly text: string }>;
			expect(lastUserParts[0].text).toBe("the original question");
		}),
	);

	it.effect("summary call failure surfaces as CompactionError in the error channel", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			const halfChars = (COMPACTION_THRESHOLD + 5000) * 2;
			const bigHistory = Prompt.make([
				{ role: "user", content: "u".repeat(halfChars) },
				{ role: "assistant", content: [{ type: "text", text: "a".repeat(halfChars) }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 3,
					history: bigHistory,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			// `Effect.flip` swaps success/error: the flipped success IS the error.
			const error = yield* Effect.flip(Stream.runDrain(session.send("next question")));
			expect(error._tag).toBe("CompactionError");
		}).pipe(
			Effect.provide(
				stubLanguageModelDual({
					summaryError: AiError.make({
						module: "stub",
						method: "generateText",
						reason: new AiError.RateLimitError({}),
					}),
					streamParts,
				}),
			),
		),
	);

	it.effect("structured-checkpoint summary prompt: the summary call asks for explicit markdown sections", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;

			const halfChars = (COMPACTION_THRESHOLD + 5000) * 2;
			const bigHistory = Prompt.make([
				{ role: "user", content: "u".repeat(halfChars) },
				{ role: "assistant", content: [{ type: "text", text: "a".repeat(halfChars) }] },
			] as never);
			yield* SubscriptionRef.set(
				session.state,
				new SessionState({
					turnCount: 3,
					history: bigHistory,
					inputTokens: 0,
					outputTokens: 0,
					compactionCount: 0,
				}),
			);

			const recording = recordingLanguageModelDual({ summaryText: "## Summary", streamParts });
			yield* Stream.runDrain(session.send("next question")).pipe(Effect.provide(recording.layer));

			expect(recording.summaryCalls).toHaveLength(1);

			// The summary call's prompt is the older history followed by a user
			// message carrying the SUMMARIZATION_INSTRUCTION (per slice 38's
			// structured-checkpoint shape). Pull the last user message's text and
			// assert every section header is present.
			const summaryPrompt = recording.summaryCalls[0].prompt as {
				readonly content: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
			};
			const lastUser = [...summaryPrompt.content].reverse().find((m) => m.role === "user");
			expect(lastUser).toBeDefined();
			const lastContent = lastUser?.content;
			const instructionText =
				typeof lastContent === "string"
					? lastContent
					: ((lastContent as ReadonlyArray<{ readonly type: string; readonly text: string }>)[0]?.text ?? "");

			expect(instructionText).toContain("## Goals");
			expect(instructionText).toContain("## Decisions");
			expect(instructionText).toContain("## Files Touched");
			expect(instructionText).toContain("## Critical Context");
			expect(instructionText).toContain("## Next Steps");
			// And the slice-28 "context checkpoint" framing language survives.
			expect(instructionText).toContain("context checkpoint");
			// The load-bearing-facts preservation preamble must survive: compaction
			// DISCARDS the summarised-away prefix, so the prompt names the categories
			// of fact that must be preserved verbatim (ADR-0019, grafted from PR #10).
			expect(instructionText).toContain("Preserve exact file paths");
			expect(instructionText).toContain("DISCARDED");
		}),
	);
});
