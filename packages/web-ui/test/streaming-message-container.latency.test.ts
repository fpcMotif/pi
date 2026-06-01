import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamingMessageContainer } from "../src/components/StreamingMessageContainer.js";

// We deliberately do NOT import ../src/components/Messages.js (which would register
// <assistant-message>). Importing it transitively pulls in i18n, which reads
// localStorage at render time and CRASHES under happy-dom (a real source robustness
// gap, independently flagged by the model-discovery / agent-interface findings).
//
// We don't need the child to render. This component's observable contract is *which*
// AgentMessage snapshot it commits to its <assistant-message> child, and *when*.
// lit-html's `.message=${msg}` property binding sets `.message` on the child element
// even while that custom element is undefined, so we read the committed snapshot back
// off the element. That keeps these tests at the correct unit boundary (markdown/DOM
// rendering is <assistant-message>'s job, covered by the Messages tests) while making
// them sharply mutation-sensitive to the batching / coalescing / clone / drop logic.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an assistant message whose single text block carries `t`. */
const assistantText = (t: string): AgentMessage =>
	({ role: "assistant", content: [{ type: "text", text: t }] }) as AgentMessage;

/** Build an assistant message carrying a single streaming toolCall block. */
const assistantToolCall = (id: string, name: string, args: string): AgentMessage =>
	({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }) as AgentMessage;

/** Resolve after the next animation frame actually fires. */
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame((t) => resolve(t)));

/** Flush a batched (non-immediate) streaming update: one frame, then Lit's render. */
async function flushBatched(el: StreamingMessageContainer): Promise<void> {
	await nextFrame();
	await el.updateComplete;
}

/** The AgentMessage the container has committed to its <assistant-message> child, or null. */
const committedMessage = (el: StreamingMessageContainer): AgentMessage | null => {
	const child = el.querySelector("assistant-message") as (Element & { message?: AgentMessage }) | null;
	return child?.message ?? null;
};

/** The committed streamed assistant text, trimmed. Empty when no assistant bubble is committed. */
const renderedText = (el: StreamingMessageContainer): string => {
	const msg = committedMessage(el);
	if (!msg || !Array.isArray(msg.content)) return "";
	const text = (msg.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text;
	return (text ?? "").trim();
};

/** The committed streaming toolCall block (by id), or undefined. */
const committedToolCall = (
	el: StreamingMessageContainer,
	id: string,
): { id: string; name: string; arguments: string } | undefined => {
	const msg = committedMessage(el);
	if (!msg || !Array.isArray(msg.content)) return undefined;
	return (msg.content as Array<{ type: string; id?: string }>).find((c) => c.type === "toolCall" && c.id === id) as
		| { id: string; name: string; arguments: string }
		| undefined;
};

/** Count of toolCall blocks in the committed message. */
const committedToolCallCount = (el: StreamingMessageContainer): number => {
	const msg = committedMessage(el);
	if (!msg || !Array.isArray(msg.content)) return 0;
	return (msg.content as Array<{ type: string }>).filter((c) => c.type === "toolCall").length;
};

describe("StreamingMessageContainer — latency & incrementality", () => {
	let el: StreamingMessageContainer;

	beforeEach(() => {
		el = new StreamingMessageContainer();
		document.body.appendChild(el);
	});

	afterEach(() => {
		el.remove();
	});

	// -----------------------------------------------------------------------
	// End-to-end streaming from a real ReadableStream of token deltas
	// -----------------------------------------------------------------------

	it("renders the concatenation of streamed deltas, one render per animation frame", async () => {
		// A realistic token stream: each chunk is the *cumulative* assistant text,
		// the way an agent emits growing AgentMessage snapshots.
		const tokens = ["The", " quick", " brown", " fox", " jumps"];
		const cumulative: string[] = [];
		tokens.reduce((acc, tok) => {
			const next = acc + tok;
			cumulative.push(next);
			return next;
		}, "");

		const stream = new ReadableStream<string>({
			start(controller) {
				for (const snapshot of cumulative) controller.enqueue(snapshot);
				controller.close();
			},
		});

		const reader = stream.getReader();
		const renderedSnapshots: string[] = [];

		// Drive the container one delta per frame so each snapshot gets its own
		// render — this is the incrementality contract the UI depends on.
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			el.setMessage(assistantText(value), false);
			await flushBatched(el);
			renderedSnapshots.push(renderedText(el));
		}

		// Incrementality: the user saw progressively longer text, never going
		// backwards and never skipping straight to the end on frame 1.
		expect(renderedSnapshots[0]).toBe("The");
		expect(renderedSnapshots[1]).toBe("The quick");
		for (let i = 1; i < renderedSnapshots.length; i++) {
			expect(renderedSnapshots[i].length).toBeGreaterThanOrEqual(renderedSnapshots[i - 1].length);
			expect(renderedSnapshots[i].startsWith(renderedSnapshots[i - 1])).toBe(true);
		}

		// Final state equals the full concatenation.
		expect(renderedText(el)).toBe("The quick brown fox jumps");
	});

	// -----------------------------------------------------------------------
	// Coalescing: many deltas inside one frame collapse to the latest snapshot
	// -----------------------------------------------------------------------

	it("coalesces a burst of deltas within a single frame to the latest snapshot (no intermediate flicker)", async () => {
		// Fire many growing snapshots synchronously — faster than one frame.
		const burst = ["H", "He", "Hel", "Hell", "Hello", "Hello,", "Hello, w", "Hello, world"];
		for (const s of burst) el.setMessage(assistantText(s), false);

		// Before any frame fires nothing is committed yet (batched, not sync).
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();

		// After exactly one frame, only the LAST snapshot is committed — the
		// intermediate ones were dropped, which is the whole point of batching.
		await flushBatched(el);
		expect(renderedText(el)).toBe("Hello, world");
	});

	it("schedules a fresh frame for the next delta after a batch has flushed", async () => {
		el.setMessage(assistantText("first"), false);
		await flushBatched(el);
		expect(renderedText(el)).toBe("first");

		// A subsequent delta must be picked up by a brand new frame, proving
		// _updateScheduled was reset after the previous flush.
		el.setMessage(assistantText("first second"), false);
		await flushBatched(el);
		expect(renderedText(el)).toBe("first second");
	});

	// -----------------------------------------------------------------------
	// Promptness / timing bounds
	// -----------------------------------------------------------------------

	it("commits a batched update promptly — within a single animation frame, not synchronously", async () => {
		el.isStreaming = true;
		await el.updateComplete; // initial loading-pulse render

		el.setMessage(assistantText("ping"), false);

		// Synchronous + microtask checkpoint: must NOT be committed yet.
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();

		const start = performance.now();
		await nextFrame();
		await el.updateComplete;
		const elapsed = performance.now() - start;

		// It DID commit after the frame…
		expect(renderedText(el)).toBe("ping");
		// …and promptly: a single frame should land well under a generous bound.
		expect(elapsed).toBeLessThan(250);
	});

	it("commits an immediate update without waiting for an animation frame", async () => {
		// Latency contract for clears / forced flushes: synchronous (next Lit tick),
		// no animation frame required.
		el.setMessage(assistantText("now"), true);
		await el.updateComplete; // no nextFrame() on purpose
		expect(renderedText(el)).toBe("now");
	});

	it("keeps per-frame commit latency bounded across a long stream", async () => {
		const FRAMES = 25;
		let worst = 0;
		for (let i = 1; i <= FRAMES; i++) {
			el.setMessage(assistantText("x".repeat(i)), false);
			const start = performance.now();
			await nextFrame();
			await el.updateComplete;
			worst = Math.max(worst, performance.now() - start);
		}
		expect(renderedText(el)).toBe("x".repeat(FRAMES));
		// No frame should stall; happy-dom rAF is timer-backed but each frame
		// must stay comfortably bounded.
		expect(worst).toBeLessThan(500);
	});

	// -----------------------------------------------------------------------
	// Mid-stream stop / clear
	// -----------------------------------------------------------------------

	it("mid-stream stop via setMessage(null) cancels the pending batched delta", async () => {
		// A delta is in flight (frame scheduled but not yet fired)…
		el.setMessage(assistantText("partial answer that will be aborted"), false);
		// …then the stream is stopped/cleared before the frame fires.
		el.setMessage(null);

		// The clear is immediate: nothing is shown right away.
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();

		// And the previously-scheduled frame must NOT resurrect the aborted text.
		await nextFrame();
		await nextFrame();
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();
		expect(renderedText(el)).toBe("");
	});

	it("supports stop-then-restart: a new stream after a clear renders cleanly", async () => {
		el.setMessage(assistantText("aborted turn"), false);
		el.setMessage(null);
		await nextFrame();
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();

		// New turn begins.
		el.setMessage(assistantText("fresh"), false);
		await flushBatched(el);
		expect(renderedText(el)).toBe("fresh");

		el.setMessage(assistantText("fresh start"), false);
		await flushBatched(el);
		expect(renderedText(el)).toBe("fresh start");
	});

	it("an immediate clear wins over a stale frame even when interleaved with another delta", async () => {
		el.setMessage(assistantText("one"), false); // schedules frame
		el.setMessage(assistantText("one two"), false); // coalesced into same frame
		el.setMessage(null); // immediate clear cancels the batch
		await nextFrame();
		await nextFrame();
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Streaming tool calls (growing arguments across frames)
	// -----------------------------------------------------------------------

	it("reflects a streaming toolCall's growing arguments across frames", async () => {
		el.setMessage(assistantToolCall("tc-1", "read_file", '{"pa'), false);
		await flushBatched(el);
		expect(committedToolCall(el, "tc-1")?.arguments).toBe('{"pa');

		// Arguments grow token-by-token; the deep-clone-per-flush must let the
		// committed snapshot advance to the latest arguments.
		el.setMessage(assistantToolCall("tc-1", "read_file", '{"path":"src/app.ts"}'), false);
		await flushBatched(el);
		expect(committedToolCall(el, "tc-1")?.arguments).toBe('{"path":"src/app.ts"}');
		// Still exactly one tool call (same id), not duplicated.
		expect(committedToolCallCount(el)).toBe(1);
	});

	// -----------------------------------------------------------------------
	// Deep-clone isolation: post-flush mutation of the caller's object must not
	// corrupt what is already committed.
	// -----------------------------------------------------------------------

	it("isolates committed state from later mutation of the caller's message object", async () => {
		const msg = assistantText("locked-in");
		el.setMessage(msg, false);
		await flushBatched(el);
		expect(renderedText(el)).toBe("locked-in");

		// Caller mutates the same reference after it was committed. Because the
		// container deep-clones on flush, the committed text must be unchanged
		// until a new setMessage call arrives.
		(msg.content as Array<{ type: string; text: string }>)[0].text = "tampered";
		await el.updateComplete;
		expect(renderedText(el)).toBe("locked-in");
	});

	// -----------------------------------------------------------------------
	// Non-assistant roles emit nothing during streaming
	// -----------------------------------------------------------------------

	it("renders nothing for a toolResult snapshot mid-stream", async () => {
		const toolResult = {
			role: "toolResult",
			content: [{ type: "toolResult", toolCallId: "tc-1", output: "ok" }],
		} as unknown as AgentMessage;
		el.setMessage(toolResult, true);
		await el.updateComplete;
		// Nothing visible is committed for a toolResult snapshot: no assistant
		// bubble and no element children (lit may leave comment markers, which is
		// why we assert on rendered elements rather than raw textContent).
		expect(el.querySelector("assistant-message")).toBeNull();
		expect(el.querySelector("*")).toBeNull();
		expect(renderedText(el)).toBe("");
	});

	it("renders nothing for a user snapshot mid-stream", async () => {
		el.setMessage({ role: "user", content: [{ type: "text", text: "hi" }] } as AgentMessage, true);
		await el.updateComplete;
		expect(el.querySelector("assistant-message")).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Loading indicator timing
	// -----------------------------------------------------------------------

	it("shows the streaming pulse immediately, then swaps to content once the first delta lands", async () => {
		el.isStreaming = true;
		await el.updateComplete;
		expect(el.querySelector(".animate-pulse")).not.toBeNull();
		expect(el.querySelector("assistant-message")).toBeNull();

		el.setMessage(assistantText("answer"), false);
		await flushBatched(el);
		expect(el.querySelector("assistant-message")).not.toBeNull();
		// While still streaming, the trailing caret pulse remains alongside content.
		expect(el.querySelector(".animate-pulse")).not.toBeNull();
		expect(renderedText(el)).toBe("answer");
	});

	// -----------------------------------------------------------------------
	// Lost-update regression: the most-recent snapshot always wins.
	//
	// When an immediate update (B) is sandwiched between a scheduled batched
	// delta (A) and a later batched delta (C):
	//   - A schedules a frame.
	//   - B (immediate) applies right away and nulls _pendingMessage, cancelling
	//     the scheduled frame's effect.
	//   - C sets _pendingMessage = C and rides the still-scheduled frame.
	//   - the frame fires and commits the latest pending snapshot, C.
	// => C is preserved; the UI does not freeze on B.
	// -----------------------------------------------------------------------

	it("commits the latest streamed delta (C) after an interleaved immediate update, not freezing on B", async () => {
		el.setMessage(assistantText("A"), false); // schedules a frame
		el.setMessage(assistantText("B"), true); // immediate apply, cancels the stale frame
		el.setMessage(assistantText("C"), false); // newer delta — rides the scheduled frame and wins

		await nextFrame();
		await nextFrame();
		await el.updateComplete;

		// The most-recent snapshot wins: "C" is committed, not the interleaved "B".
		expect(renderedText(el)).toBe("C");
	});
});
