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

const prompt = (...messages: ReadonlyArray<Prompt.Message>): Prompt.Prompt => Prompt.fromMessages(messages);
const systemMessage = (content: string): Prompt.SystemMessage => Prompt.makeMessage("system", { content });
const userMessage = (content: string): Prompt.UserMessage => Prompt.makeMessage("user", { content });
const assistantMessage = (content: ReadonlyArray<Prompt.AssistantMessagePart>): Prompt.AssistantMessage =>
	Prompt.makeMessage("assistant", { content });
const toolMessage = (content: ReadonlyArray<Prompt.ToolMessagePart>): Prompt.ToolMessage =>
	Prompt.makeMessage("tool", { content });
const textPart = (text: string): Prompt.TextPart => Prompt.makePart("text", { text });
const reasoningPart = (text: string): Prompt.ReasoningPart => Prompt.makePart("reasoning", { text });
const filePart = (data: string | Uint8Array | URL, fileName?: string): Prompt.FilePart =>
	Prompt.makePart("file", { mediaType: "text/plain", fileName, data });

describe("estimateTokens", () => {
	it("estimates chars/4 across all message text content", () => {
		const history = prompt(
			userMessage("hello"), // 5 chars
			assistantMessage([textPart("hi there")]), // 8 chars
		);

		// (5 + 8) / 4 = 3.25 → ceil → 4
		expect(estimateTokens(history)).toBe(4);
	});

	it("counts tool-call and tool-result content, not just text", () => {
		const textOnly = prompt(assistantMessage([textPart("x".repeat(40))]));
		const withTool = prompt(
			assistantMessage([
				textPart("x".repeat(40)),
				Prompt.makePart("tool-call", { id: "c1", name: "GetWeather", params: { city: "Paris" } }),
			]),
			toolMessage([
				Prompt.makePart("tool-result", {
					id: "c1",
					name: "GetWeather",
					isFailure: false,
					result: { temperature: 72 },
				}),
			]),
		);

		expect(estimateTokens(withTool)).toBeGreaterThan(estimateTokens(textOnly));
	});

	it("treats non-serializable tool payloads and omitted approval reasons as zero chars", () => {
		const history = prompt(
			assistantMessage([Prompt.makePart("tool-call", { id: "c1", name: "Noop", params: undefined })]),
			toolMessage([
				Prompt.makePart("tool-result", {
					id: "c1",
					name: "Noop",
					isFailure: false,
					result: undefined,
				}),
				Prompt.makePart("tool-approval-response", {
					approvalId: "a1",
					approved: true,
				}),
			]),
		);

		expect(estimateTokens(history)).toBe(5);
	});

	it("counts reasoning blocks that Session persists into assistant history", () => {
		const textOnly = prompt(assistantMessage([textPart("x".repeat(40))]));
		const withReasoning = prompt(assistantMessage([textPart("x".repeat(40)), reasoningPart("r".repeat(80))]));

		expect(estimateTokens(withReasoning)).toBeGreaterThan(estimateTokens(textOnly));
	});

	it("counts file data variants and tool approval parts", () => {
		const textOnly = prompt(assistantMessage([textPart("x".repeat(40))]));
		const withFilesAndApprovals = prompt(
			assistantMessage([
				textPart("x".repeat(40)),
				filePart("abcdef", "note.txt"),
				filePart(Uint8Array.from([1, 2, 3, 4]), "bytes.bin"),
				filePart(new URL("file:///tmp/pi.txt")),
				Prompt.makePart("tool-approval-request", { approvalId: "approval-1", toolCallId: "call-1" }),
			]),
			toolMessage([
				Prompt.makePart("tool-approval-response", {
					approvalId: "approval-1",
					approved: false,
					reason: "needs narrower scope",
				}),
			]),
		);

		expect(estimateTokens(withFilesAndApprovals)).toBeGreaterThan(estimateTokens(textOnly));
	});

	it("counts system-prompt text (decoded system content is a bare string)", () => {
		const history = prompt(
			systemMessage("you are helpful"), // 15 chars
			userMessage("hi"), // 2 chars
		);

		// (15 + 2) / 4 = 4.25 → ceil → 5
		expect(estimateTokens(history)).toBe(5);
	});
});

describe("shouldCompact", () => {
	it("is false when the estimate is at or below the threshold", () => {
		const history = prompt(userMessage("hello")); // ~2 tokens
		expect(shouldCompact(history, 100)).toBe(false);
	});

	it("is true when the estimate exceeds the threshold", () => {
		const history = prompt(userMessage("x".repeat(1000))); // 250 tokens
		expect(shouldCompact(history, 100)).toBe(true);
	});
});

describe("splitHistory", () => {
	it("cuts at a message boundary, keeping ~keepRecentTokens of recent messages", () => {
		// Four messages, 100 tokens each (400 chars / 4).
		const history = prompt(
			userMessage("a".repeat(400)),
			assistantMessage([textPart("b".repeat(400))]),
			userMessage("c".repeat(400)),
			assistantMessage([textPart("d".repeat(400))]),
		);

		// Walking back: msg4 (100) < 150, msg3 (+100 = 200) >= 150 → cut at msg3.
		const { toSummarize, toKeep } = splitHistory(history, 150);

		expect(toSummarize.content.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(toKeep.content.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(toKeep.content).toHaveLength(2);
	});

	it("never orphans a tool-result: moves the cut back to include the tool-call's assistant message", () => {
		const history = prompt(
			userMessage("a".repeat(400)),
			assistantMessage([
				textPart("b".repeat(400)),
				Prompt.makePart("tool-call", { id: "c1", name: "Read", params: { path: "/x" } }),
			]),
			toolMessage([
				Prompt.makePart("tool-result", { id: "c1", name: "Read", isFailure: false, result: "z".repeat(400) }),
			]),
			assistantMessage([textPart("d".repeat(400))]),
		);

		// Walking back: msg4 (100) < 150, msg3 the tool message tips it past 150 →
		// natural cut lands on the `tool` message, which would orphan its result.
		// The cut must move back to the preceding `assistant` message (msg2).
		const { toSummarize, toKeep } = splitHistory(history, 150);

		expect(toSummarize.content.map((m) => m.role)).toEqual(["user"]);
		expect(toKeep.content.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
	});
});
