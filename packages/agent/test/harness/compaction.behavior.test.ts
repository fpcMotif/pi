/**
 * Deeper behavior / boundary / latency tests for the compaction token-accounting
 * and threshold ALGORITHM (the heart of the agent runtime).
 *
 * These intentionally go beyond test/harness/compaction.test.ts: they pin EXACT
 * decisions (which entry is the cut, which messages are summarized vs preserved,
 * computed token totals, off-by-one threshold boundaries) instead of asserting
 * that the functions merely "return something".
 *
 * The pure functions are imported and called directly. The Effect/async surface
 * (generateSummary / compact) is exercised only through the real fauxProvider
 * registration that pi-ai ships for exactly this purpose.
 */

import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	type CompactionSettings,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	getLastAssistantUsage,
	prepareCompaction,
	shouldCompact,
} from "../../src/harness/compaction/compaction.js";
import { buildSessionContext } from "../../src/harness/session/session.js";
import type { CompactionEntry, MessageEntry, SessionTreeEntry } from "../../src/harness/types.js";
import type { AgentMessage } from "../../src/types.js";

// ----------------------------------------------------------------------------
// Builders
// ----------------------------------------------------------------------------

let nextId = 0;
function createId(): string {
	return `entry-${nextId++}`;
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMsg(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantMsg(text: string, u: Usage = usage(100, 50)): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: u,
		stopReason: "stop",
		timestamp: 1,
	};
}

function entry(message: AgentMessage, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function compactionEntry(
	summary: string,
	firstKeptEntryId: string,
	parentId: string | null = null,
	extra: Partial<CompactionEntry> = {},
): CompactionEntry {
	return {
		type: "compaction",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 1234,
		...extra,
	};
}

const fauxRegistrations: FauxProviderRegistration[] = [];

function fauxModel(reasoning = false, maxTokens = 8192): { faux: FauxProviderRegistration; model: Model<string> } {
	const faux = registerFauxProvider({
		models: [
			{ id: reasoning ? "reasoning-model" : "non-reasoning-model", reasoning, contextWindow: 200000, maxTokens },
		],
	});
	fauxRegistrations.push(faux);
	return { faux, model: faux.getModel() };
}

afterEach(() => {
	while (fauxRegistrations.length > 0) fauxRegistrations.pop()?.unregister();
});

beforeEach(() => {
	nextId = 0;
});

// ============================================================================
// shouldCompact — exact threshold + off-by-one boundary
// ============================================================================

describe("shouldCompact threshold boundary", () => {
	const settings: CompactionSettings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
	const window = 200000;
	// trigger boundary = window - reserveTokens = 183616. Fires only when STRICTLY greater.
	const boundary = window - settings.reserveTokens;

	it("does NOT fire exactly AT the boundary (uses strict >, not >=)", () => {
		expect(boundary).toBe(183616);
		expect(shouldCompact(boundary, window, settings)).toBe(false);
	});

	it("does NOT fire one token UNDER the boundary", () => {
		expect(shouldCompact(boundary - 1, window, settings)).toBe(false);
	});

	it("fires one token OVER the boundary", () => {
		expect(shouldCompact(boundary + 1, window, settings)).toBe(true);
	});

	it("disabled settings never fire even far past the boundary", () => {
		expect(shouldCompact(window * 10, window, { ...settings, enabled: false })).toBe(false);
	});

	it("reserveTokens larger than the window makes the threshold negative so any positive usage fires", () => {
		const huge = { ...settings, reserveTokens: window + 1 };
		expect(shouldCompact(0, window, huge)).toBe(true); // 0 > -1
		// And a negative usage (shouldn't happen, but pins the pure comparison) does not fire.
		expect(shouldCompact(-2, window, huge)).toBe(false); // -2 > -1 is false
	});
});

// ============================================================================
// calculateContextTokens — usage field accounting, the `||` fallback trap
// ============================================================================

describe("calculateContextTokens accounting", () => {
	it("prefers the native totalTokens when it is a positive number", () => {
		// Components sum to 1800 but totalTokens says 9999 — native wins.
		const u: Usage = { ...usage(1000, 500, 200, 100), totalTokens: 9999 };
		expect(calculateContextTokens(u)).toBe(9999);
	});

	it("honors a legitimately reported totalTokens of 0 instead of summing components", () => {
		// FIXED: `??` (nullish coalescing) honors a real 0. A reported 0 means the
		// provider genuinely accounted zero context tokens; it must NOT be treated as
		// "missing" and silently replaced by the component sum (10+5+2+1 = 18).
		const u: Usage = { ...usage(10, 5, 2, 1), totalTokens: 0 };
		expect(calculateContextTokens(u)).toBe(0);
	});

	it("falls back to the component sum (input+output+cacheRead+cacheWrite) only when totalTokens is absent", () => {
		// When totalTokens is nullish the fallback sums ALL four components, not just input+output.
		const u = { ...usage(10, 5, 7, 3), totalTokens: undefined } as unknown as Usage;
		expect(calculateContextTokens(u)).toBe(25);
	});

	it("all-zero usage with totalTokens 0 yields 0 (no NaN)", () => {
		const u: Usage = { ...usage(0, 0, 0, 0), totalTokens: 0 };
		expect(calculateContextTokens(u)).toBe(0);
	});
});

// ============================================================================
// estimateTokens — Math.ceil(chars/4), multi-block, image, line endings
// ============================================================================

describe("estimateTokens char accounting", () => {
	it("rounds UP partial tokens (ceil, not floor)", () => {
		// 1 char -> ceil(1/4) = 1, 4 chars -> 1, 5 chars -> 2.
		expect(estimateTokens(userMsg("a"))).toBe(1);
		expect(estimateTokens(userMsg("abcd"))).toBe(1);
		expect(estimateTokens(userMsg("abcde"))).toBe(2);
	});

	it("empty user content is 0 tokens (ceil(0/4) === 0)", () => {
		expect(estimateTokens(userMsg(""))).toBe(0);
		expect(estimateTokens({ role: "user", content: "", timestamp: 1 } as AgentMessage)).toBe(0);
	});

	it("sums every text block of an assistant message before dividing", () => {
		// Two text blocks of 4 + 8 = 12 chars -> ceil(12/4) = 3. NOT ceil(4/4)+ceil(8/4)=3 by luck;
		// use 5 + 5 = 10 -> ceil(10/4)=3, where per-block ceil would give 2+2=4 — proves single divide.
		const msg = {
			...assistantMsg("", usage(0, 0)),
			content: [
				{ type: "text", text: "abcde" },
				{ type: "text", text: "fghij" },
			],
		} as AssistantMessage;
		expect(estimateTokens(msg)).toBe(3);
	});

	it("counts a tool call as name length + JSON-serialized arguments length", () => {
		const msg = {
			...assistantMsg("", usage(0, 0)),
			content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "src/index.ts" } }],
		} as AssistantMessage;
		// "read"(4) + JSON.stringify({path:"src/index.ts"}) = '{"path":"src/index.ts"}' (23) = 27 -> ceil(27/4)=7
		expect(estimateTokens(msg)).toBe(7);
	});

	it("estimates an image block at the documented 4800-char flat rate (1200 tokens)", () => {
		const msg = {
			role: "custom",
			content: [{ type: "image", mediaType: "image/png", data: "x" }],
			timestamp: 1,
		} as unknown as AgentMessage;
		expect(estimateTokens(msg)).toBe(1200); // ceil(4800/4)
	});

	it("counts newline / CRLF characters as real chars (no normalization)", () => {
		// CRLF is two literal chars, LF is one. Same logical text differs in char count,
		// which proves estimateTokens does NOT normalize line endings before counting.
		// "ab\r\ncd\r\nef" = 6 letters + 2*2 CRLF = 10 chars -> ceil(10/4) = 3 tokens.
		const crlfText = userMsg("ab\r\ncd\r\nef");
		// "ab\ncd\nef" = 6 letters + 2 LF = 8 chars -> ceil(8/4) = 2 tokens.
		const lfText = userMsg("ab\ncd\nef");
		expect(estimateTokens(crlfText)).toBe(3);
		expect(estimateTokens(lfText)).toBe(2);
		// The CRLF variant must be strictly larger; if line endings were stripped/normalized
		// the two would be equal.
		expect(estimateTokens(crlfText)).toBeGreaterThan(estimateTokens(lfText));
		const crlf = userMsg("x".repeat(2) + "\r\n".repeat(3)); // 2 + 6 = 8 chars -> 2 tokens
		expect(estimateTokens(crlf)).toBe(2);
	});

	it("bashExecution counts command + output chars together", () => {
		const msg = {
			role: "bashExecution",
			command: "echo hello", // 10
			output: "world!!", // 7
			exitCode: 0,
			timestamp: 1,
		} as unknown as AgentMessage;
		// 17 chars -> ceil(17/4) = 5
		expect(estimateTokens(msg)).toBe(5);
	});

	it("summary messages count summary chars only", () => {
		const branch = {
			role: "branchSummary",
			summary: "abcdefgh",
			fromId: "r",
			timestamp: 1,
		} as unknown as AgentMessage;
		expect(estimateTokens(branch)).toBe(2); // ceil(8/4)
	});
});

// ============================================================================
// estimateContextTokens — usage vs estimated trailing, missing usage
// ============================================================================

describe("estimateContextTokens hybrid accounting", () => {
	it("with NO assistant usage, sums chars/4 of every message and reports null lastUsageIndex", () => {
		const messages = [userMsg("abcd"), userMsg("efghij")]; // 1 + 2 = 3
		const out = estimateContextTokens(messages);
		expect(out).toEqual({ tokens: 3, usageTokens: 0, trailingTokens: 3, lastUsageIndex: null });
	});

	it("anchors on the LAST assistant usage and adds only estimated trailing messages after it", () => {
		const a = assistantMsg("ignored-text-because-usage-wins", usage(10, 5, 2, 3)); // usageTokens = 20
		const trailing = userMsg("x".repeat(16)); // ceil(16/4) = 4
		const out = estimateContextTokens([a, trailing]);
		expect(out.usageTokens).toBe(20);
		expect(out.trailingTokens).toBe(4);
		expect(out.tokens).toBe(24);
		expect(out.lastUsageIndex).toBe(0);
	});

	it("ignores chars of messages BEFORE the last usage (usage already accounts for them)", () => {
		const huge = userMsg("y".repeat(4000)); // 1000 chars-tokens if estimated
		const a = assistantMsg("a", usage(7, 0)); // usageTokens 7
		const out = estimateContextTokens([huge, a]);
		// last usage is index 1, nothing trails -> tokens === usageTokens, the 1000-token user is NOT added.
		expect(out.tokens).toBe(7);
		expect(out.trailingTokens).toBe(0);
		expect(out.lastUsageIndex).toBe(1);
	});

	it("skips aborted/errored assistant usage when finding the anchor and falls back to estimation", () => {
		const aborted = { ...assistantMsg("zzzz", usage(999, 999)), stopReason: "aborted" } as AssistantMessage;
		const errored = { ...assistantMsg("wwww", usage(999, 999)), stopReason: "error" } as AssistantMessage;
		const out = estimateContextTokens([aborted, errored]);
		// No usable usage -> pure estimate of both bodies: "zzzz"(1) + "wwww"(1) = 2
		expect(out.usageTokens).toBe(0);
		expect(out.lastUsageIndex).toBeNull();
		expect(out.tokens).toBe(2);
	});

	it("empty history estimates to zero with null anchor", () => {
		expect(estimateContextTokens([])).toEqual({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null });
	});
});

// ============================================================================
// getLastAssistantUsage — most-recent-valid selection
// ============================================================================

describe("getLastAssistantUsage selection", () => {
	it("returns the most recent VALID usage, skipping later aborted/errored entries", () => {
		const good = entry(assistantMsg("good", usage(5, 2)));
		const aborted = entry({ ...assistantMsg("aborted"), stopReason: "aborted" }, good.id);
		const errored = entry({ ...assistantMsg("errored"), stopReason: "error" }, aborted.id);
		expect(getLastAssistantUsage([good, aborted, errored])).toEqual(usage(5, 2));
	});

	it("returns undefined when there is no assistant message at all", () => {
		expect(getLastAssistantUsage([entry(userMsg("hi"))])).toBeUndefined();
		expect(getLastAssistantUsage([])).toBeUndefined();
	});

	it("prefers a later valid usage over an earlier one", () => {
		const first = entry(assistantMsg("a", usage(1, 1)));
		const u = entry(userMsg("between"), first.id);
		const second = entry(assistantMsg("b", usage(9, 9)), u.id);
		expect(getLastAssistantUsage([first, u, second])).toEqual(usage(9, 9));
	});
});

// ============================================================================
// findCutPoint — exact off-by-one cut placement & split-turn detection
// ============================================================================

describe("findCutPoint exact placement (off-by-one boundary)", () => {
	/**
	 * Build a deterministic 6-turn chain where every message's token cost is known:
	 *   user content len 4  -> ceil(4/4)  = 1 token
	 *   assistant text len 40 -> ceil(40/4) = 10 tokens
	 * Entries: [u0,a0,u1,a1,u2,a2,u3,a3,u4,a4,u5,a5] indices 0..11.
	 * Backward accumulation (from index 11):
	 *   i=11 a5  acc 10
	 *   i=10 u5  acc 11
	 *   i= 9 a4  acc 21
	 *   i= 8 u4  acc 22
	 *   ...
	 * Every user & assistant index is a valid cut point.
	 */
	function buildChain(): MessageEntry[] {
		const entries: MessageEntry[] = [];
		let parent: string | null = null;
		for (let i = 0; i < 6; i++) {
			const u = entry(userMsg("uuuu"), parent); // 4 chars -> 1 token
			entries.push(u);
			const a = entry(assistantMsg("a".repeat(40), usage(0, 0)), u.id); // 40 chars -> 10 tokens
			entries.push(a);
			parent = a.id;
		}
		return entries;
	}

	it("keep=11 stops the accumulator exactly at u5 (index 10): cut is a USER msg, NOT a split turn", () => {
		const entries = buildChain();
		const res = findCutPoint(entries, 0, entries.length, 11);
		expect(res.firstKeptEntryIndex).toBe(10);
		expect(entries[10].message.role).toBe("user");
		expect(res.isSplitTurn).toBe(false);
		expect(res.turnStartIndex).toBe(-1);
	});

	it("keep=12 (one token over) shifts the cut back to a4 (index 9): an ASSISTANT msg -> SPLIT turn", () => {
		const entries = buildChain();
		const res = findCutPoint(entries, 0, entries.length, 12);
		expect(res.firstKeptEntryIndex).toBe(9);
		expect(entries[9].message.role).toBe("assistant");
		expect(res.isSplitTurn).toBe(true);
		// The turn being split starts at u4 (index 8).
		expect(res.turnStartIndex).toBe(8);
		expect(entries[8].message.role).toBe("user");
	});

	it("keep=21 still cuts at a4 (split), but keep=22 snaps back to u4 (no split): off-by-one boundary", () => {
		const entries = buildChain();
		const at = findCutPoint(entries, 0, entries.length, 21);
		expect(at.firstKeptEntryIndex).toBe(9);
		expect(at.isSplitTurn).toBe(true);

		const over = findCutPoint(buildChain(), 0, entries.length, 22);
		expect(over.firstKeptEntryIndex).toBe(8);
		expect(over.isSplitTurn).toBe(false);
		expect(over.turnStartIndex).toBe(-1);
	});

	it("keepRecentTokens larger than the WHOLE history keeps everything from the first cut point (index 0)", () => {
		const entries = buildChain();
		// Total tokens 66; budget never reached, so cutIndex stays at the default cutPoints[0] === 0.
		const res = findCutPoint(entries, 0, entries.length, 100000);
		expect(res.firstKeptEntryIndex).toBe(0);
		expect(entries[0].message.role).toBe("user");
		expect(res.isSplitTurn).toBe(false);
	});

	it("respects startIndex: a cut never lands before the boundary; tiny budget keeps only the newest msg", () => {
		const entries = buildChain();
		// Start at index 6 (u3). cutPoints are [6..11]. With keep=1 the accumulator trips on a5
		// (index 11, 10 tokens) immediately; the closest cut point >= 11 is index 11 itself (a5 is a
		// valid assistant cut point). So only the single newest message is kept.
		const res = findCutPoint(entries, 6, entries.length, 1);
		expect(res.firstKeptEntryIndex).toBe(11);
		expect(res.firstKeptEntryIndex).toBeGreaterThanOrEqual(6);
		expect(entries[11].message.role).toBe("assistant");
	});

	it("an empty range (no valid cut points) returns startIndex with no split", () => {
		const entries = buildChain();
		expect(findCutPoint(entries, 3, 3, 5)).toEqual({
			firstKeptEntryIndex: 3,
			turnStartIndex: -1,
			isSplitTurn: false,
		});
	});

	it("never cuts at a tool result: falls back to the LATEST valid cut point at or before it", () => {
		const u = entry(userMsg("uuuu"));
		const a = entry(
			{
				...assistantMsg("call", usage(0, 0)),
				content: [{ type: "toolCall", id: "tc", name: "read", arguments: { path: "f.ts" } }],
			} as AssistantMessage,
			u.id,
		);
		const tr = entry(
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(400) }],
				isError: false,
				timestamp: 1,
			} as unknown as AgentMessage,
			a.id,
		);
		const entries = [u, a, tr];
		// toolResult is huge (400 chars -> 100 tokens) so the accumulator trips on it (index 2).
		// Tool results are NOT valid cut points, and there is no valid cut point AT OR AFTER index 2.
		// FIXED (BUG 2): instead of collapsing all the way back to the FIRST cut point (the user at
		// index 0) — which would compact far more than intended — the cut now falls back to the
		// LATEST valid cut point at or before index 2: the assistant at index 1. Its tool call's
		// result (index 2) follows it and is kept, preserving the most recent context possible while
		// never landing the cut on the tool result itself.
		const res = findCutPoint(entries, 0, entries.length, 50);
		expect(res.firstKeptEntryIndex).toBe(1);
		expect(entries[res.firstKeptEntryIndex].message.role).not.toBe("toolResult");
		expect(entries[res.firstKeptEntryIndex].message.role).toBe("assistant");
		// Cutting at the assistant mid-turn is a split turn whose opener is the user at index 0.
		expect(res.isSplitTurn).toBe(true);
		expect(res.turnStartIndex).toBe(0);
	});

	it("scans backward over leading non-message entries but STOPS at a compaction boundary", () => {
		const boundary = compactionEntry("prev", "kept");
		const u = entry(userMsg("u".repeat(400)), boundary.id); // big user, trips budget
		const entries: SessionTreeEntry[] = [boundary, u];
		const res = findCutPoint(entries, 0, entries.length, 1);
		// cut is the user at index 1; the compaction boundary at index 0 is NOT pulled in.
		expect(res.firstKeptEntryIndex).toBe(1);
	});
});

describe("findTurnStartIndex", () => {
	it("walks back to the user message that opened the turn", () => {
		const u = entry(userMsg("start"));
		const a = entry(assistantMsg("reply"), u.id);
		const tr = entry(
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "read",
				content: [{ type: "text", text: "r" }],
				isError: false,
				timestamp: 1,
			} as unknown as AgentMessage,
			a.id,
		);
		expect(findTurnStartIndex([u, a, tr], 2, 0)).toBe(0);
	});

	it("returns -1 when no user/bash turn-start exists before the index", () => {
		const a = entry(assistantMsg("only assistant"));
		expect(findTurnStartIndex([a], 0, 0)).toBe(-1);
	});

	it("treats a bashExecution entry as a turn start", () => {
		const bash = entry({
			role: "bashExecution",
			command: "ls",
			output: "",
			exitCode: 0,
			timestamp: 1,
		} as unknown as AgentMessage);
		const a = entry(assistantMsg("after bash"), bash.id);
		expect(findTurnStartIndex([bash, a], 1, 0)).toBe(0);
	});
});

// ============================================================================
// prepareCompaction — what gets summarized vs preserved, totals, prev-summary
// ============================================================================

describe("prepareCompaction decisions", () => {
	it("empty branch yields undefined", () => {
		expect(prepareCompaction([], DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});

	it("a single user message (no usable cut budget) keeps everything: nothing to summarize", () => {
		const u = entry(userMsg("only message"));
		const prep = prepareCompaction([u], { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
		expect(prep).toBeDefined();
		expect(prep?.firstKeptEntryId).toBe(u.id);
		expect(prep?.messagesToSummarize).toEqual([]);
		expect(prep?.isSplitTurn).toBe(false);
		expect(prep?.previousSummary).toBeUndefined();
	});

	it("a branch whose LEAF is already a compaction returns undefined (no double compaction)", () => {
		const u = entry(userMsg("hi"));
		const c = compactionEntry("already done", u.id, u.id);
		expect(prepareCompaction([u, c], DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});

	it("tokensBefore equals estimateContextTokens(buildSessionContext(...)) of the full path", () => {
		const u1 = entry(userMsg("first"));
		const a1 = entry(assistantMsg("reply", usage(5000, 1000)), u1.id);
		const u2 = entry(userMsg("second"), a1.id);
		const a2 = entry(assistantMsg("done", usage(8000, 2000)), u2.id);
		const path = [u1, a1, u2, a2];
		const prep = prepareCompaction(path, { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
		const expected = estimateContextTokens(buildSessionContext(path).messages).tokens;
		expect(prep?.tokensBefore).toBe(expected);
		// And that value reflects the latest valid usage (10000 from a2) + zero trailing.
		expect(expected).toBe(10000);
	});

	it("carries the latest compaction summary forward as previousSummary and starts the boundary after it", () => {
		const u1 = entry(userMsg("u1"));
		const a1 = entry(assistantMsg("a1"), u1.id);
		const u2 = entry(userMsg("u2"), a1.id);
		const a2 = entry(assistantMsg("a2", usage(5000, 1000)), u2.id);
		const comp = compactionEntry("FIRST SUMMARY", u2.id, a2.id);
		const u3 = entry(userMsg("u3-after"), comp.id);
		const a3 = entry(assistantMsg("a3-after", usage(8000, 2000)), u3.id);
		const path = [u1, a1, u2, a2, comp, u3, a3];

		const prep = prepareCompaction(path, { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
		expect(prep?.previousSummary).toBe("FIRST SUMMARY");
		// keepRecentTokens=1 trips immediately on a3, so the cut lands on a3 (split turn whose
		// start is u3). The boundary for THIS round starts at the prior compaction's
		// firstKeptEntryId (u2, index 2), NOT at the start of the path.
		expect(prep?.firstKeptEntryId).toBe(a3.id);
		expect(prep?.isSplitTurn).toBe(true);
		// History to summarize = entries from the boundary (u2) up to the split-turn start (u3),
		// excluding the compaction entry itself: exactly [u2, a2].
		expect(prep?.messagesToSummarize.map((m) => m.role)).toEqual(["user", "assistant"]);
		const summarizedText = JSON.stringify(prep?.messagesToSummarize);
		expect(summarizedText).toContain("u2");
		expect(summarizedText).toContain("a2");
		// Pre-compaction messages u1/a1 are BEFORE the previous compaction's firstKeptEntryId (u2),
		// so they are excluded from this round's summarization entirely.
		expect(summarizedText).not.toContain("u1");
		expect(summarizedText).not.toContain("a1");
		expect(summarizedText).not.toContain("u3-after");
		// The split turn's prefix (u3-after, the cut-turn opener) becomes turnPrefixMessages.
		expect(prep?.turnPrefixMessages.map((m) => m.role)).toEqual(["user"]);
		expect(JSON.stringify(prep?.turnPrefixMessages)).toContain("u3-after");
	});

	it("when the previous compaction firstKeptEntryId is MISSING, boundary starts right after the compaction entry", () => {
		const before = entry(userMsg("before"));
		const missing = compactionEntry("prev summary", "no-such-entry", before.id);
		const after = entry(userMsg("after"), missing.id);
		const aAfter = entry(assistantMsg("done", usage(4000, 500)), after.id);
		const prep = prepareCompaction([before, missing, after, aAfter], {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 1,
		});
		expect(prep?.previousSummary).toBe("prev summary");
		expect(prep?.firstKeptEntryId).toBe(aAfter.id);
		// "before" is upstream of the compaction; nothing summarized this round.
		expect(prep?.messagesToSummarize).toEqual([]);
	});

	it("split-turn preparation: history excludes the split turn's prefix, which becomes turnPrefixMessages", () => {
		// u1/a1 = prior turn (history), u2/a2 = split turn (a2 is the cut). Make a2 large so the
		// budget trips inside the second turn.
		const u1 = entry(userMsg("prior turn request"));
		const a1 = entry(assistantMsg("prior reply", usage(0, 0)), u1.id);
		const u2 = entry(userMsg("split turn request"), a1.id);
		const a2 = entry(assistantMsg("x".repeat(400), usage(0, 0)), u2.id); // 100 tokens
		const path = [u1, a1, u2, a2];

		const prep = prepareCompaction(path, { enabled: true, reserveTokens: 100, keepRecentTokens: 50 });
		expect(prep?.isSplitTurn).toBe(true);
		// firstKept is a2 (the assistant cut), the split turn starts at u2.
		expect(prep?.firstKeptEntryId).toBe(a2.id);
		// history = everything before the split turn start: u1, a1.
		expect(prep?.messagesToSummarize.map((m) => m.role)).toEqual(["user", "assistant"]);
		// turn prefix = the split turn's prefix before the cut: just u2.
		expect(prep?.turnPrefixMessages.map((m) => m.role)).toEqual(["user"]);
	});

	it("accumulates file ops from the messages being summarized (read/write/edit dedup + sort downstream)", () => {
		const u1 = entry(userMsg("do work"));
		const aRead = entry(
			{
				...assistantMsg("reading", usage(0, 0)),
				content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/b.ts" } }],
			} as AssistantMessage,
			u1.id,
		);
		const aEdit = entry(
			{
				...assistantMsg("editing", usage(0, 0)),
				content: [{ type: "toolCall", id: "2", name: "edit", arguments: { path: "src/a.ts" } }],
			} as AssistantMessage,
			aRead.id,
		);
		// Recent turn kept (large) so the file-op turns above land in messagesToSummarize.
		const uRecent = entry(userMsg("recent"), aEdit.id);
		const aRecent = entry(assistantMsg("z".repeat(400), usage(0, 0)), uRecent.id);
		const path = [u1, aRead, aEdit, uRecent, aRecent];

		const prep = prepareCompaction(path, { enabled: true, reserveTokens: 100, keepRecentTokens: 50 });
		expect(prep?.fileOps.read).toEqual(new Set(["src/b.ts"]));
		expect(prep?.fileOps.edited).toEqual(new Set(["src/a.ts"]));
	});

	it("seeds file ops from a prior pi-generated compaction's details (but NOT from fromHook compactions)", () => {
		const u1 = entry(userMsg("u1"));
		const a1 = entry(assistantMsg("a1", usage(0, 0)), u1.id);
		const comp = compactionEntry("prev", u1.id, a1.id, {
			details: { readFiles: ["src/seeded-read.ts"], modifiedFiles: ["src/seeded-edit.ts"] },
		});
		const uRecent = entry(userMsg("recent"), comp.id);
		const aRecent = entry(assistantMsg("z".repeat(400), usage(0, 0)), uRecent.id);
		const prep = prepareCompaction([u1, a1, comp, uRecent, aRecent], {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 50,
		});
		expect(prep?.fileOps.read).toEqual(new Set(["src/seeded-read.ts"]));
		expect(prep?.fileOps.edited).toEqual(new Set(["src/seeded-edit.ts"]));
	});

	it("does NOT seed file ops from a fromHook compaction's details", () => {
		const u1 = entry(userMsg("u1"));
		const a1 = entry(assistantMsg("a1", usage(0, 0)), u1.id);
		const comp = compactionEntry("prev", u1.id, a1.id, {
			fromHook: true,
			details: { readFiles: ["src/should-be-ignored.ts"], modifiedFiles: [] },
		});
		const uRecent = entry(userMsg("recent"), comp.id);
		const aRecent = entry(assistantMsg("z".repeat(400), usage(0, 0)), uRecent.id);
		const prep = prepareCompaction([u1, a1, comp, uRecent, aRecent], {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 50,
		});
		expect(prep?.fileOps.read).toEqual(new Set());
	});

	it("returns undefined (needs migration) when the first kept entry has no id", () => {
		const u = { ...entry(userMsg("x".repeat(400))), id: "" } as MessageEntry;
		const prep = prepareCompaction([u], { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
		expect(prep).toBeUndefined();
	});
});

// ============================================================================
// compact — end-to-end summary assembly via fauxProvider (genuine async)
// ============================================================================

describe("compact summary assembly", () => {
	it("appends sorted read/modified file sections and reflects them in details", async () => {
		const prep: CompactionPreparation = {
			firstKeptEntryId: "keep",
			messagesToSummarize: [userMsg("history")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1000,
			fileOps: {
				read: new Set(["src/z-read.ts", "src/a-read.ts", "src/dup.ts"]),
				written: new Set(["src/written.ts"]),
				edited: new Set(["src/edited.ts", "src/dup.ts"]), // dup.ts is modified -> drops from readFiles
			},
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20000 },
		};
		const { faux, model } = fauxModel();
		faux.setResponses([fauxAssistantMessage("## Goal\nbody")]);
		const result = await compact(prep, model, "k");

		expect(result.summary.startsWith("## Goal\nbody")).toBe(true);
		// read-only files are sorted and exclude dup.ts (which is modified).
		expect(result.summary).toContain("<read-files>\nsrc/a-read.ts\nsrc/z-read.ts\n</read-files>");
		// modified = edited ∪ written, sorted; includes dup.ts.
		expect(result.summary).toContain(
			"<modified-files>\nsrc/dup.ts\nsrc/edited.ts\nsrc/written.ts\n</modified-files>",
		);
		expect(result.details).toEqual({
			readFiles: ["src/a-read.ts", "src/z-read.ts"],
			modifiedFiles: ["src/dup.ts", "src/edited.ts", "src/written.ts"],
		});
		expect(result.tokensBefore).toBe(1000);
		expect(result.firstKeptEntryId).toBe("keep");
	});

	it("emits no file sections when there are zero file ops", async () => {
		const prep: CompactionPreparation = {
			firstKeptEntryId: "keep",
			messagesToSummarize: [userMsg("history")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20000 },
		};
		const { faux, model } = fauxModel();
		faux.setResponses([fauxAssistantMessage("## Goal\nonly")]);
		const result = await compact(prep, model, "k");
		expect(result.summary).toBe("## Goal\nonly");
		expect(result.summary).not.toContain("<read-files>");
		expect(result.summary).not.toContain("<modified-files>");
	});

	it("merges history + turn-prefix summaries with the split-turn marker when splitting", async () => {
		const prep: CompactionPreparation = {
			firstKeptEntryId: "keep",
			messagesToSummarize: [userMsg("old history")],
			turnPrefixMessages: [userMsg("split prefix")],
			isSplitTurn: true,
			tokensBefore: 5,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20000 },
		};
		const { faux, model } = fauxModel();
		// Two completions: history summary, then turn-prefix summary (Promise.all order is positional).
		faux.setResponses([fauxAssistantMessage("HISTORY-SUMMARY"), fauxAssistantMessage("PREFIX-SUMMARY")]);
		const result = await compact(prep, model, "k");
		expect(result.summary).toContain("HISTORY-SUMMARY");
		expect(result.summary).toContain("**Turn Context (split turn):**");
		expect(result.summary).toContain("PREFIX-SUMMARY");
	});

	it("uses the 'No prior history.' placeholder for a split turn with empty history", async () => {
		const prep: CompactionPreparation = {
			firstKeptEntryId: "keep",
			messagesToSummarize: [],
			turnPrefixMessages: [userMsg("split prefix only")],
			isSplitTurn: true,
			tokensBefore: 5,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20000 },
		};
		const { faux, model } = fauxModel();
		faux.setResponses([fauxAssistantMessage("PREFIX-ONLY")]);
		const result = await compact(prep, model, "k");
		expect(result.summary).toContain("No prior history.");
		expect(result.summary).toContain("PREFIX-ONLY");
	});

	it("rejects when firstKeptEntryId is empty (session needs migration)", async () => {
		const prep: CompactionPreparation = {
			firstKeptEntryId: "",
			messagesToSummarize: [userMsg("history")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20000 },
		};
		const { faux, model } = fauxModel();
		faux.setResponses([fauxAssistantMessage("summary")]);
		await expect(compact(prep, model, "k")).rejects.toThrow("First kept entry has no UUID");
	});
});

// ============================================================================
// LATENCY / throughput — deciding compaction over a very large history is
// bounded and not pathologically O(n^2).
// ============================================================================

describe("latency: large history is bounded (not O(n^2))", () => {
	function buildLargePath(turns: number): SessionTreeEntry[] {
		const entries: SessionTreeEntry[] = [];
		let parent: string | null = null;
		for (let i = 0; i < turns; i++) {
			const u = entry(userMsg(`request ${i} ${"x".repeat(20)}`), parent);
			entries.push(u);
			const a = entry(assistantMsg(`reply ${i} ${"y".repeat(40)}`, usage(100 + i, 50)), u.id);
			entries.push(a);
			parent = a.id;
		}
		return entries;
	}

	it("prepareCompaction over 5,000 turns (10k entries) completes well under a generous bound", () => {
		const path = buildLargePath(5000);
		const start = performance.now();
		const prep = prepareCompaction(path, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
		const elapsed = performance.now() - start;
		expect(prep).toBeDefined();
		// Linear work on 10k entries should be milliseconds; 2s is a generous, machine-independent ceiling.
		expect(elapsed).toBeLessThan(2000);
	});

	it("scaling from 1x to 4x history grows roughly linearly, not quadratically", () => {
		const measure = (turns: number): number => {
			const path = buildLargePath(turns);
			// Warm + measure best-of-3 to reduce GC/JIT noise.
			let best = Number.POSITIVE_INFINITY;
			for (let r = 0; r < 3; r++) {
				const t0 = performance.now();
				prepareCompaction(path, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
				best = Math.min(best, performance.now() - t0);
			}
			return best;
		};
		const small = measure(1500);
		const large = measure(6000); // 4x the entries
		// O(n^2) would be ~16x. Allow a very loose 10x ceiling (plus a small constant floor for tiny times).
		expect(large).toBeLessThan(small * 10 + 25);
	});

	it("findCutPoint alone over 100k entries stays bounded", () => {
		const path = buildLargePath(50000); // 100k entries
		const start = performance.now();
		const res = findCutPoint(path, 0, path.length, 20000);
		const elapsed = performance.now() - start;
		expect(res.firstKeptEntryIndex).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(1000);
	});
});
