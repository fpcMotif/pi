/**
 * Tracer bullets for slice 28 — compaction triggers (ADR-0009 "wrapping").
 *
 * Pure helpers in `effect/compaction.ts`:
 *
 * - `estimateTokens(history)` — chars/4 heuristic over the `Prompt` content.
 * - `shouldCompact(history, threshold)` — pure trigger predicate.
 * - `splitHistory(history, keepRecentTokens)` — cut-point detection.
 */
import { Prompt } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";

import { estimateTokens, shouldCompact, splitHistory } from "../../effect/compaction.js";

describe("estimateTokens", () => {
	it("estimates chars/4 across all message text content", () => {
		const history = Prompt.make([
			{ role: "user", content: "hello" }, // 5 chars
			{ role: "assistant", content: [{ type: "text", text: "hi there" }] }, // 8 chars
		] as never);

		// (5 + 8) / 4 = 3.25 → ceil → 4
		expect(estimateTokens(history)).toBe(4);
	});

	it("counts tool-call and tool-result content, not just text", () => {
		const textOnly = Prompt.make([{ role: "assistant", content: [{ type: "text", text: "x".repeat(40) }] }] as never);
		const withTool = Prompt.make([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "x".repeat(40) },
					{ type: "tool-call", id: "c1", name: "GetWeather", params: { city: "Paris" } },
				],
			},
			{
				role: "tool",
				content: [
					{ type: "tool-result", id: "c1", name: "GetWeather", isFailure: false, result: { temperature: 72 } },
				],
			},
		] as never);

		expect(estimateTokens(withTool)).toBeGreaterThan(estimateTokens(textOnly));
	});

	it("counts system-prompt text (decoded system content is a bare string)", () => {
		const history = Prompt.make([
			{ role: "system", content: "you are helpful" }, // 15 chars
			{ role: "user", content: "hi" }, // 2 chars
		] as never);

		// (15 + 2) / 4 = 4.25 → ceil → 5
		expect(estimateTokens(history)).toBe(5);
	});
});

describe("shouldCompact", () => {
	it("is false when the estimate is at or below the threshold", () => {
		const history = Prompt.make([{ role: "user", content: "hello" }] as never); // ~2 tokens
		expect(shouldCompact(history, 100)).toBe(false);
	});

	it("is true when the estimate exceeds the threshold", () => {
		const history = Prompt.make([{ role: "user", content: "x".repeat(1000) }] as never); // 250 tokens
		expect(shouldCompact(history, 100)).toBe(true);
	});
});

describe("splitHistory", () => {
	it("cuts at a message boundary, keeping ~keepRecentTokens of recent messages", () => {
		// Four messages, 100 tokens each (400 chars / 4).
		const history = Prompt.make([
			{ role: "user", content: "a".repeat(400) },
			{ role: "assistant", content: [{ type: "text", text: "b".repeat(400) }] },
			{ role: "user", content: "c".repeat(400) },
			{ role: "assistant", content: [{ type: "text", text: "d".repeat(400) }] },
		] as never);

		// Walking back: msg4 (100) < 150, msg3 (+100 = 200) >= 150 → cut at msg3.
		const { toSummarize, toKeep } = splitHistory(history, 150);

		expect(toSummarize.content.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(toKeep.content.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(toKeep.content).toHaveLength(2);
	});

	it("never orphans a tool-result: moves the cut back to include the tool-call's assistant message", () => {
		const history = Prompt.make([
			{ role: "user", content: "a".repeat(400) },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "b".repeat(400) },
					{ type: "tool-call", id: "c1", name: "Read", params: { path: "/x" } },
				],
			},
			{
				role: "tool",
				content: [{ type: "tool-result", id: "c1", name: "Read", isFailure: false, result: "z".repeat(400) }],
			},
			{ role: "assistant", content: [{ type: "text", text: "d".repeat(400) }] },
		] as never);

		// Walking back: msg4 (100) < 150, msg3 the tool message tips it past 150 →
		// natural cut lands on the `tool` message, which would orphan its result.
		// The cut must move back to the preceding `assistant` message (msg2).
		const { toSummarize, toKeep } = splitHistory(history, 150);

		expect(toSummarize.content.map((m) => m.role)).toEqual(["user"]);
		expect(toKeep.content.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
	});
});
