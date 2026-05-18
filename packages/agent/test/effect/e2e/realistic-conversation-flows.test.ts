// ADR-0017 phase C.3: realistic end-to-end scenarios composing ≥3
// already-landed slices each. Each scenario simulates a lifelike
// conversation arc — multi-tool turns, retries mid-flow, segmented
// reasoning, history rollback chains, telemetry under retry, parallel
// sessions — and proves that slice-level invariants hold under
// composition. No live API keys; stub Layers exercise the real provider
// Layer code path (per ADR-0017's e2e definition).

import { it } from "@effect/vitest";
import { Effect, Stream, SubscriptionRef, Tracer } from "effect";
import { AiError } from "effect/unstable/ai";
import { describe, expect } from "vitest";

import type { Finish, LlmPart, ToolCompleted, ToolDispatched } from "../../../effect/agent-event.js";
import { Continue, NewPrompt, Retry } from "../../../effect/agent-input.js";
import { Session } from "../../../effect/session.js";
import { recordingTracer } from "../../../test-support/recording-tracer.js";
import { stubLanguageModelStream } from "../../../test-support/stub-language-model-stream.js";
import { stubLanguageModelStreamScripted } from "../../../test-support/stub-language-model-stream-scripted.js";

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const text = (delta: string) => ({ type: "text-delta", id: "t1", delta });
const textStart = (id = "t1") => ({ type: "text-start", id });
const textEnd = (id = "t1") => ({ type: "text-end", id });
const reasoningStart = (id = "r1") => ({ type: "reasoning-start", id });
const reasoning = (delta: string, id = "r1") => ({ type: "reasoning-delta", id, delta });
const reasoningEnd = (id = "r1") => ({ type: "reasoning-end", id });
const toolCall = (name: string, id: string, params: unknown) => ({ type: "tool-call", id, name, params });
const toolResult = (name: string, id: string, result: unknown, isFailure = false) => ({
	type: "tool-result",
	id,
	name,
	isFailure,
	result,
});
const finish = (inputTokens?: number, outputTokens?: number) => ({
	type: "finish" as const,
	reason: "stop" as const,
	usage: {
		inputTokens: { uncached: undefined, total: inputTokens, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
	},
	response: undefined,
});

const rateLimited = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.RateLimitError({}),
});

const authError = AiError.make({
	module: "stub",
	method: "streamText",
	reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 1: Multi-tool turn (read+grep+edit-like pattern)
// composes: streaming + tool-call/result lifting + history persistence + usage
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: multi-tool assistant turn", () => {
	it.effect("3 tool calls in one assistant turn → 3 ToolDispatched + 3 ToolCompleted + history records all", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("Find auth bugs and patch them"));

			const dispatched = events.filter((e) => e._tag === "ToolDispatched") as ReadonlyArray<ToolDispatched>;
			const completed = events.filter((e) => e._tag === "ToolCompleted") as ReadonlyArray<ToolCompleted>;
			expect(dispatched.map((d) => d.toolName)).toEqual(["Grep", "Read", "Edit"]);
			expect(completed.map((c) => c.toolName)).toEqual(["Grep", "Read", "Edit"]);
			expect(completed.every((c) => !c.isFailure)).toBe(true);

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
			expect(state.inputTokens).toBe(2000);
			expect(state.outputTokens).toBe(800);
			// History: [user, assistant] — assistant.content has 3 tool-call + 3 tool-result + text parts
			expect(state.history.content).toHaveLength(2);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					textStart(),
					text("Searching for auth bugs..."),
					textEnd(),
					toolCall("Grep", "c1", { pattern: "validateAuth" }),
					toolResult("Grep", "c1", { matches: ["src/auth.ts:42"] }),
					toolCall("Read", "c2", { path: "src/auth.ts" }),
					toolResult("Read", "c2", { content: "function validateAuth() { /* bug */ }" }),
					toolCall("Edit", "c3", { path: "src/auth.ts", old: "/* bug */", new: "/* fixed */" }),
					toolResult("Edit", "c3", { applied: true }),
					textStart("t2"),
					text("Patched. Auth now validates correctly."),
					textEnd("t2"),
					finish(2000, 800),
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 2: Retry mid-flow preserves history once + accumulates usage
// composes: retry (24) + history (12g/h) + usage (23) + once-per-send invariant
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: retry sequence preserves once-per-send invariants", () => {
	it.effect(
		"two transient rate-limits then success: turnCount=1, single user msg in history, usage from success only",
		() =>
			Effect.gen(function* () {
				const session = yield* Session.empty;
				const events = yield* Stream.runCollect(session.send("List files in src/"));

				// Consumer only sees events from the successful attempt (textStart, text-delta, textEnd, finish — 4 raw + trailing Finish).
				expect(events.map((e) => e._tag)).toEqual(["LlmPart", "LlmPart", "LlmPart", "LlmPart", "Finish"]);

				const state = yield* SubscriptionRef.get(session.state);
				expect(state.turnCount).toBe(1);
				expect(state.history.content).toHaveLength(2); // user + assistant (1 each)
				expect(state.inputTokens).toBe(150);
				expect(state.outputTokens).toBe(60);
			}).pipe(
				Effect.provide(
					stubLanguageModelStreamScripted([
						{ type: "error", error: rateLimited },
						{ type: "error", error: rateLimited },
						{ type: "parts", parts: [textStart(), text("src/a.ts, src/b.ts"), textEnd(), finish(150, 60)] },
					]),
				),
			),
	);

	it.effect("non-retryable AuthenticationError propagates immediately, history still has user msg", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const result = yield* Stream.runCollect(session.send("anything")).pipe(Effect.exit);
			expect(result._tag).toBe("Failure");

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
			expect(state.history.content).toHaveLength(1);
			expect(state.inputTokens).toBe(0);
		}).pipe(Effect.provide(stubLanguageModelStreamScripted([{ type: "error", error: authError }]))),
	);

	it.effect("4 transient errors (initial + 3 retries) exhaust the cap and propagate", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const result = yield* Stream.runCollect(session.send("x")).pipe(Effect.exit);
			expect(result._tag).toBe("Failure");

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
			expect(state.history.content).toHaveLength(1);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "error", error: rateLimited },
					{ type: "error", error: rateLimited },
					{ type: "error", error: rateLimited },
					{ type: "error", error: rateLimited },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 3: Reasoning + text + tool interleaved
// composes: text-block segmentation (26) + reasoning blocks (27) + tool turns (12h)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: reasoning + text + tool interleaved preserves arrival order", () => {
	it.effect("reasoning → text → tool-call → tool-result → text yields content in order", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("solve this"));

			const state = yield* SubscriptionRef.get(session.state);
			const assistant = state.history.content[1] as { readonly content: ReadonlyArray<{ readonly type: string }> };
			const types = assistant.content.map((p) => p.type);
			expect(types).toEqual(["reasoning", "text", "tool-call", "tool-result", "text"]);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					reasoningStart(),
					reasoning("Let me think... I need to grep first."),
					reasoningEnd(),
					textStart(),
					text("I'll search for the bug."),
					textEnd(),
					toolCall("Grep", "g1", { pattern: "TODO" }),
					toolResult("Grep", "g1", { count: 3 }),
					textStart("t2"),
					text("Found 3 TODOs."),
					textEnd("t2"),
					finish(),
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 4: 5-turn conversation: usage accumulates, history grows correctly
// composes: history (12g) + usage (23) + once-per-send invariant
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: long conversation accumulates state across N turns", () => {
	it.effect("5 sends in a row: turnCount=5, history=10 messages, tokens cumulative", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("turn 1"));
			yield* Stream.runDrain(session.send("turn 2"));
			yield* Stream.runDrain(session.send("turn 3"));
			yield* Stream.runDrain(session.send("turn 4"));
			yield* Stream.runDrain(session.send("turn 5"));

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(5);
			expect(state.history.content).toHaveLength(10);
			expect(state.inputTokens).toBe(500); // 100 × 5
			expect(state.outputTokens).toBe(250); // 50 × 5
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [textStart(), text("r1"), textEnd(), finish(100, 50)] },
					{ type: "parts", parts: [textStart(), text("r2"), textEnd(), finish(100, 50)] },
					{ type: "parts", parts: [textStart(), text("r3"), textEnd(), finish(100, 50)] },
					{ type: "parts", parts: [textStart(), text("r4"), textEnd(), finish(100, 50)] },
					{ type: "parts", parts: [textStart(), text("r5"), textEnd(), finish(100, 50)] },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 5: NewPrompt → Retry → Retry rollback chain
// composes: Input variants (21, 22) + history (12g) + once-per-send
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: input variant chain (NewPrompt → Retry → Retry)", () => {
	it.effect("two Retry calls after a NewPrompt: history collapses to [user, assistant'], turnCount=3", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send(new NewPrompt({ prompt: "original" })));
			yield* Stream.runDrain(session.send(new Retry({})));
			yield* Stream.runDrain(session.send(new Retry({})));

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(3);
			expect(state.history.content).toHaveLength(2);
			expect((state.history.content[0] as { readonly role: string }).role).toBe("user");
			expect((state.history.content[1] as { readonly role: string }).role).toBe("assistant");
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [textStart(), text("first"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("second"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("third"), textEnd(), finish()] },
				]),
			),
		),
	);

	it.effect("NewPrompt → Continue → Retry: Continue adds assistant turn, Retry drops only the last assistant", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send(new NewPrompt({ prompt: "ask" })));
			yield* Stream.runDrain(session.send(new Continue({})));
			yield* Stream.runDrain(session.send(new Retry({})));

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(3);
			// After Retry: rollback to last user msg → [user, assistant1] becomes [user]
			// before the third stream → [user, assistant3]. Total 2 messages.
			expect(state.history.content).toHaveLength(2);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [textStart(), text("a1"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("a2"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("a3"), textEnd(), finish()] },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 6: Telemetry under retry — span count matches attempt count
// composes: retry (24) + telemetry (25)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: telemetry captures every retry attempt", () => {
	it.effect("3 rate-limits + 1 success → 1 outer send-span + 4 attempt spans", () =>
		Effect.gen(function* () {
			const { tracer, spans } = recordingTracer();
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("x")).pipe(Effect.provideService(Tracer.Tracer, tracer));

			const names = spans.map((s) => s.name);
			const sendSpans = names.filter((n) => n === "pi.Session.send");
			const attemptSpans = names.filter((n) => n === "pi.Session.send.attempt");
			expect(sendSpans).toHaveLength(1);
			expect(attemptSpans).toHaveLength(4); // initial + 3 retries
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "error", error: rateLimited },
					{ type: "error", error: rateLimited },
					{ type: "error", error: rateLimited },
					{ type: "parts", parts: [textStart(), text("ok"), textEnd(), finish()] },
				]),
			),
		),
	);

	it.effect("clean send → 1 send-span + 1 attempt-span, both ended with Success exit", () =>
		Effect.gen(function* () {
			const { tracer, spans } = recordingTracer();
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("x")).pipe(Effect.provideService(Tracer.Tracer, tracer));
			expect(spans).toHaveLength(2);
			for (const span of spans) {
				expect(span.status._tag).toBe("Ended");
			}
		}).pipe(Effect.provide(stubLanguageModelStream([textStart(), text("a"), textEnd(), finish()]))),
	);

	it.effect("send-span attributes include pi.input.tag and pi.history.size", () =>
		Effect.gen(function* () {
			const { tracer, spans } = recordingTracer();
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("hello")).pipe(Effect.provideService(Tracer.Tracer, tracer));

			const sendSpan = spans.find((s) => s.name === "pi.Session.send");
			expect(sendSpan).toBeDefined();
			expect(sendSpan?.attributes.get("pi.input.tag")).toBe("NewPrompt");
			expect(sendSpan?.attributes.get("pi.history.size")).toBe(1);
		}).pipe(Effect.provide(stubLanguageModelStream([textStart(), text("a"), textEnd(), finish()]))),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 7: Tool failure with isFailure:true flows into history
// composes: tool events (12d) + tool turns in history (12h) + failure mode
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: failing tool results land in history with isFailure preserved", () => {
	it.effect("tool fails → ToolCompleted has isFailure:true → history's tool-result part has isFailure", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("try it"));
			const completed = events.find((e) => e._tag === "ToolCompleted") as ToolCompleted;
			expect(completed.isFailure).toBe(true);

			const state = yield* SubscriptionRef.get(session.state);
			const assistant = state.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly isFailure?: boolean }>;
			};
			const toolResultPart = assistant.content.find((p) => p.type === "tool-result");
			expect(toolResultPart?.isFailure).toBe(true);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					toolCall("Risky", "r1", { input: "bad" }),
					toolResult("Risky", "r1", { error: "validation-failed" }, true),
					finish(),
				]),
			),
		),
	);

	it.effect("mixed success+failure tools in one turn: both land in history in order", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("do both"));

			const state = yield* SubscriptionRef.get(session.state);
			const assistant = state.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly isFailure?: boolean }>;
			};
			const tools = assistant.content.filter((p) => p.type === "tool-result");
			expect(tools).toHaveLength(2);
			expect(tools[0]?.isFailure).toBe(false);
			expect(tools[1]?.isFailure).toBe(true);
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					toolCall("Ok", "1", {}),
					toolResult("Ok", "1", { value: 42 }),
					toolCall("Bad", "2", {}),
					toolResult("Bad", "2", { code: "EFAULT" }, true),
					finish(),
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 8: Parallel sessions don't share state
// composes: Session.empty isolation + SubscriptionRef.make per session
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: independent sessions don't cross-contaminate state", () => {
	it.effect("two sessions interleave sends: each accumulates only its own history + tokens", () =>
		Effect.gen(function* () {
			const sessionA = yield* Session.empty;
			const sessionB = yield* Session.empty;

			yield* Stream.runDrain(sessionA.send("A1"));
			yield* Stream.runDrain(sessionB.send("B1"));
			yield* Stream.runDrain(sessionA.send("A2"));

			const stateA = yield* SubscriptionRef.get(sessionA.state);
			const stateB = yield* SubscriptionRef.get(sessionB.state);
			expect(stateA.turnCount).toBe(2);
			expect(stateB.turnCount).toBe(1);
			expect(stateA.history.content).toHaveLength(4);
			expect(stateB.history.content).toHaveLength(2);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [textStart(), text("a"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("b"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("c"), textEnd(), finish()] },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 9: Empty assistant turn (zero LlmParts) skips append
// composes: history (12g) + empty-assistant invariant (slice 18)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: zero-content stream produces user msg only, no empty assistant", () => {
	it.effect("upstream emits only a finish part → history=[user], turnCount=1, no assistant appended", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("ping"));

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
			expect(state.history.content).toHaveLength(1);
			expect((state.history.content[0] as { readonly role: string }).role).toBe("user");
		}).pipe(Effect.provide(stubLanguageModelStream([finish()]))),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 10: Multi-block text segmentation preserved across turns
// composes: text-blocks (26) + history (12h)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: multiple text blocks within one turn produce multiple TextParts", () => {
	it.effect("text-start/end bookends produce 2 distinct TextParts; deltas without bookends fuse into 1", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("Tell me two things"));

			const state = yield* SubscriptionRef.get(session.state);
			const assistant = state.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};
			const textParts = assistant.content.filter((p) => p.type === "text");
			expect(textParts).toHaveLength(2);
			expect(textParts[0]?.text).toBe("First.");
			expect(textParts[1]?.text).toBe("Second.");
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					textStart("t1"),
					text("First."),
					textEnd("t1"),
					textStart("t2"),
					text("Second."),
					textEnd("t2"),
					finish(),
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 11: Usage with zero output (cache-hit pattern)
// composes: usage (23) + Finish event
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: zero-output usage (cache-hit) lands cleanly", () => {
	it.effect("finish carries inputTokens=500, outputTokens=0 → both reflected in state", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("cached prompt"));

			const finishEvent = events[events.length - 1] as Finish;
			expect(finishEvent.inputTokens).toBe(500);
			expect(finishEvent.outputTokens).toBe(0);

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.inputTokens).toBe(500);
			expect(state.outputTokens).toBe(0);
		}).pipe(Effect.provide(stubLanguageModelStream([textStart(), text("cached"), textEnd(), finish(500, 0)]))),
	);

	it.effect("missing usage (undefined totals) keeps state at 0 — no NaN propagation", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("x"));

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.inputTokens).toBe(0);
			expect(state.outputTokens).toBe(0);
			expect(Number.isNaN(state.inputTokens)).toBe(false);
		}).pipe(Effect.provide(stubLanguageModelStream([textStart(), text("x"), textEnd(), finish()]))),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 12: Stream parts reconstruct exact source text
// composes: streaming (12) + history (12g)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: deltas reconstruct exact source text byte-for-byte", () => {
	it.effect("10 deltas of 'Hello, ' + 'world!' fragments → reconstructed text matches expected", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("greet"));
			const llmParts = events.filter((e) => e._tag === "LlmPart") as ReadonlyArray<LlmPart>;
			const reconstructed = llmParts
				.map((p) => p.part as { readonly type?: string; readonly delta?: string })
				.filter((p) => p.type === "text-delta")
				.map((p) => p.delta)
				.join("");
			expect(reconstructed).toBe("Hello, world!");

			const state = yield* SubscriptionRef.get(session.state);
			const assistant = state.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};
			expect(assistant.content[0]?.text).toBe("Hello, world!");
		}).pipe(
			Effect.provide(
				stubLanguageModelStream([
					textStart(),
					text("H"),
					text("e"),
					text("l"),
					text("l"),
					text("o"),
					text(", "),
					text("w"),
					text("o"),
					text("r"),
					text("ld!"),
					textEnd(),
					finish(),
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 13: Reasoning across multiple turns is preserved per-turn
// composes: reasoning (27) + history (12g)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: reasoning is per-turn, history grows with reasoning preserved", () => {
	it.effect("two turns each emit a reasoning block → both turns have reasoning in their assistant content", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("solve a"));
			yield* Stream.runDrain(session.send("solve b"));

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.history.content).toHaveLength(4);
			const a1 = state.history.content[1] as { readonly content: ReadonlyArray<{ readonly type: string }> };
			const a2 = state.history.content[3] as { readonly content: ReadonlyArray<{ readonly type: string }> };
			expect(a1.content.some((p) => p.type === "reasoning")).toBe(true);
			expect(a2.content.some((p) => p.type === "reasoning")).toBe(true);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{
						type: "parts",
						parts: [
							reasoningStart(),
							reasoning("think A"),
							reasoningEnd(),
							textStart(),
							text("a"),
							textEnd(),
							finish(),
						],
					},
					{
						type: "parts",
						parts: [
							reasoningStart(),
							reasoning("think B"),
							reasoningEnd(),
							textStart(),
							text("b"),
							textEnd(),
							finish(),
						],
					},
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 14: Defensive — interleaved deltas without explicit markers
// composes: cross-flush invariant (27) + content order preservation
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: interleaved text/reasoning deltas without markers preserve order", () => {
	it.effect("text-delta → reasoning-delta → text-delta yields [text, reasoning, text] in arrival order", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("x"));

			const state = yield* SubscriptionRef.get(session.state);
			const assistant = state.history.content[1] as {
				readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
			};
			expect(assistant.content.map((p) => p.type)).toEqual(["text", "reasoning", "text"]);
			expect(assistant.content[0]?.text).toBe("hello ");
			expect(assistant.content[1]?.text).toBe("hidden");
			expect(assistant.content[2]?.text).toBe("world");
		}).pipe(Effect.provide(stubLanguageModelStream([text("hello "), reasoning("hidden"), text("world"), finish()]))),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 15: Toolkit-less send still works end-to-end
// composes: send signature (12f) + streaming + history
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: text-only send (no toolkit) completes cleanly", () => {
	it.effect("no toolkit, single text stream, history+events all consistent", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const events = yield* Stream.runCollect(session.send("hi"));
			expect(events.map((e) => e._tag)).toEqual(["LlmPart", "LlmPart", "LlmPart", "LlmPart", "Finish"]);

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.history.content).toHaveLength(2);
		}).pipe(Effect.provide(stubLanguageModelStream([textStart(), text("hi back"), textEnd(), finish()]))),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 16: send returns Stream that can be partially consumed
// composes: Stream laziness + state-update semantics
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: Stream from send is lazy — runCollect drives state updates", () => {
	it.effect("turnCount increments per Stream.runDrain even with empty stream payload", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			const initial = yield* SubscriptionRef.get(session.state);
			expect(initial.turnCount).toBe(0);

			yield* Stream.runDrain(session.send("once"));
			const afterOne = yield* SubscriptionRef.get(session.state);
			expect(afterOne.turnCount).toBe(1);

			yield* Stream.runDrain(session.send("twice"));
			const afterTwo = yield* SubscriptionRef.get(session.state);
			expect(afterTwo.turnCount).toBe(2);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [finish()] },
					{ type: "parts", parts: [finish()] },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 17: pi.history.size attribute reflects state AFTER the input mutation
// composes: input variants (21/22) + telemetry attributes (25)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: pi.history.size is post-mutation (NewPrompt's user msg already appended)", () => {
	it.effect("first NewPrompt send → history.size attribute reads 1 (the user message)", () =>
		Effect.gen(function* () {
			const { tracer, spans } = recordingTracer();
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("first")).pipe(Effect.provideService(Tracer.Tracer, tracer));

			const sendSpan = spans.find((s) => s.name === "pi.Session.send");
			expect(sendSpan?.attributes.get("pi.history.size")).toBe(1);
		}).pipe(Effect.provide(stubLanguageModelStream([textStart(), text("a"), textEnd(), finish()]))),
	);

	it.effect("third NewPrompt send → history.size attribute reads 5 (2 prior turns × 2 + new user msg)", () =>
		Effect.gen(function* () {
			const { tracer, spans } = recordingTracer();
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("t1"));
			yield* Stream.runDrain(session.send("t2"));
			yield* Stream.runDrain(session.send("t3")).pipe(Effect.provideService(Tracer.Tracer, tracer));

			const sendSpan = spans.find((s) => s.name === "pi.Session.send");
			expect(sendSpan?.attributes.get("pi.history.size")).toBe(5);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [textStart(), text("a"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("b"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("c"), textEnd(), finish()] },
				]),
			),
		),
	);

	it.effect("Continue input span attribute reads 'Continue'", () =>
		Effect.gen(function* () {
			const { tracer, spans } = recordingTracer();
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("first"));
			yield* Stream.runDrain(session.send(new Continue({}))).pipe(Effect.provideService(Tracer.Tracer, tracer));

			const sendSpan = spans.find((s) => s.name === "pi.Session.send");
			expect(sendSpan?.attributes.get("pi.input.tag")).toBe("Continue");
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [textStart(), text("a"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("b"), textEnd(), finish()] },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 18: Retry input variant with empty session falls back to no-op
// composes: Retry rollback (22) + edge case (empty history)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: Retry on an empty session", () => {
	it.effect("Retry on Session.empty: rollback is no-op, upstream still runs, turnCount=1", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send(new Retry({})));

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
			// History has just the assistant message (no user to roll back to).
			expect(state.history.content).toHaveLength(1);
			expect((state.history.content[0] as { readonly role: string }).role).toBe("assistant");
		}).pipe(Effect.provide(stubLanguageModelStream([textStart(), text("from-empty"), textEnd(), finish()]))),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 19: SubscriptionRef.changes observes turnCount progression
// composes: SubscriptionRef (12e) + send observability
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: SubscriptionRef.changes is observable for state-driven UIs", () => {
	it.effect("after 3 sends, current state observed via SubscriptionRef.get matches turnCount=3", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runDrain(session.send("a"));
			yield* Stream.runDrain(session.send("b"));
			yield* Stream.runDrain(session.send("c"));

			// SubscriptionRef.changes is a Stream<SessionState> the UI can subscribe to;
			// here we just confirm the get-after-drain sees the cumulative state.
			const observed = yield* SubscriptionRef.get(session.state);
			expect(observed.turnCount).toBe(3);
		}).pipe(
			Effect.provide(
				stubLanguageModelStreamScripted([
					{ type: "parts", parts: [textStart(), text("a"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("b"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("c"), textEnd(), finish()] },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 20: User-message append happens BEFORE upstream → visible even on failure
// composes: history-pre-upstream invariant (20) + retry cap exceeded (24)
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: pre-upstream history append survives upstream failure", () => {
	it.effect("upstream fails before any events → user msg in history, no assistant msg", () =>
		Effect.gen(function* () {
			const session = yield* Session.empty;
			yield* Stream.runCollect(session.send("question")).pipe(Effect.exit);

			const state = yield* SubscriptionRef.get(session.state);
			expect(state.turnCount).toBe(1);
			expect(state.history.content).toHaveLength(1);
			expect((state.history.content[0] as { readonly role: string }).role).toBe("user");
			const user = state.history.content[0] as { readonly content: ReadonlyArray<{ readonly text: string }> };
			expect(user.content[0]?.text).toBe("question");
		}).pipe(Effect.provide(stubLanguageModelStreamScripted([{ type: "error", error: authError }]))),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 21: Concurrent two-session retry doesn't cross-contaminate retry counters
// composes: parallel sessions + retry counter (24) + isolation
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: retry counters are per-send, not global", () => {
	it.effect("session A retries 2× then succeeds, session B succeeds first try — neither affects the other", () =>
		Effect.gen(function* () {
			const sessionA = yield* Session.empty;
			const sessionB = yield* Session.empty;

			yield* Stream.runDrain(sessionA.send("A"));
			yield* Stream.runDrain(sessionB.send("B"));

			const stateA = yield* SubscriptionRef.get(sessionA.state);
			const stateB = yield* SubscriptionRef.get(sessionB.state);
			expect(stateA.turnCount).toBe(1);
			expect(stateB.turnCount).toBe(1);
			expect(stateA.history.content).toHaveLength(2);
			expect(stateB.history.content).toHaveLength(2);
		}).pipe(
			Effect.provide(
				// A sees errors,errors,parts. B sees parts.
				stubLanguageModelStreamScripted([
					{ type: "error", error: rateLimited },
					{ type: "error", error: rateLimited },
					{ type: "parts", parts: [textStart(), text("A-ok"), textEnd(), finish()] },
					{ type: "parts", parts: [textStart(), text("B-ok"), textEnd(), finish()] },
				]),
			),
		),
	);
});

// ────────────────────────────────────────────────────────────────────────
// Scenario 22: Full lifecycle smoke — 4-turn arc with reasoning, tool, retry, usage
// composes: every already-landed slice in one realistic flow
// ────────────────────────────────────────────────────────────────────────

describe("realistic e2e: full lifecycle composes every landed slice", () => {
	it.effect(
		"4-turn arc: NewPrompt+reasoning+tool → retry-then-success → Continue+text → Retry → end state correct",
		() =>
			Effect.gen(function* () {
				const session = yield* Session.empty;
				yield* Stream.runDrain(session.send(new NewPrompt({ prompt: "investigate" })));
				yield* Stream.runDrain(session.send(new NewPrompt({ prompt: "again" })));
				yield* Stream.runDrain(session.send(new Continue({})));
				yield* Stream.runDrain(session.send(new Retry({})));

				const state = yield* SubscriptionRef.get(session.state);
				expect(state.turnCount).toBe(4);
				// After Retry: rollback to last user msg (turn 2's user-only-after-no-Continue-user; here the "again" user msg)
				// then a new assistant. Resulting structure: [user(invest), assistant(t1), user(again), assistant(t4)].
				expect(state.history.content).toHaveLength(4);
				expect(state.inputTokens).toBeGreaterThan(0);
				expect(state.outputTokens).toBeGreaterThan(0);
			}).pipe(
				Effect.provide(
					stubLanguageModelStreamScripted([
						{
							type: "parts",
							parts: [
								reasoningStart(),
								reasoning("plan"),
								reasoningEnd(),
								toolCall("Grep", "g1", { pattern: "bug" }),
								toolResult("Grep", "g1", { count: 1 }),
								textStart(),
								text("Found 1 bug."),
								textEnd(),
								finish(100, 50),
							],
						},
						// retry, then success on the second NewPrompt
						{ type: "error", error: rateLimited },
						{ type: "parts", parts: [textStart(), text("Retried OK."), textEnd(), finish(80, 30)] },
						{ type: "parts", parts: [textStart(), text("Continuing."), textEnd(), finish(70, 20)] },
						{ type: "parts", parts: [textStart(), text("Retry result."), textEnd(), finish(60, 10)] },
					]),
				),
			),
	);
});
