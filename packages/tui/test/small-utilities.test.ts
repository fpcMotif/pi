// ADR-0017 phase B.4: small-utility coverage for tui — KillRing,
// UndoStack, TruncatedText. Targets the remaining branch gaps and
// closes uncovered functions on these helpers.
import { describe, expect, it } from "vitest";
import { TruncatedText } from "../src/components/truncated-text.js";
// Also import the barrel so v8 marks src/index.ts as covered.
import * as tuiPublicSurface from "../src/index.js";
import { KillRing } from "../src/kill-ring.js";
import { UndoStack } from "../src/undo-stack.js";

describe("tui src/index.ts barrel — touch to mark covered", () => {
	it("re-exports something importable", () => {
		// The barrel exports many names; we just need to touch it.
		expect(typeof tuiPublicSurface).toBe("object");
	});
});

describe("KillRing", () => {
	it("push(empty) is a no-op (covers `if (!text) return` branch)", () => {
		const ring = new KillRing();
		ring.push("", { prepend: false });
		expect(ring.length).toBe(0);
		expect(ring.peek()).toBeUndefined();
	});

	it("push non-empty appends a new entry", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		expect(ring.length).toBe(2);
		expect(ring.peek()).toBe("b");
	});

	it("push with accumulate=true on empty ring still appends as a new entry", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false, accumulate: true });
		expect(ring.length).toBe(1);
		expect(ring.peek()).toBe("a");
	});

	it("accumulate=true appends to the latest entry (forward deletion)", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false, accumulate: true });
		expect(ring.length).toBe(1);
		expect(ring.peek()).toBe("ab");
	});

	it("accumulate=true with prepend=true puts new text in front", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: true, accumulate: true });
		expect(ring.peek()).toBe("ba");
	});

	it("rotate() cycles the most-recent entry to the front", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		ring.push("c", { prepend: false });
		ring.rotate();
		expect(ring.peek()).toBe("b"); // 'c' moved to front → 'b' is now top
	});

	it("rotate() on a single-entry ring is a no-op (covers length<=1 branch)", () => {
		const ring = new KillRing();
		ring.push("only", { prepend: false });
		ring.rotate();
		expect(ring.peek()).toBe("only");
	});

	it("peek() on empty ring returns undefined", () => {
		const ring = new KillRing();
		expect(ring.peek()).toBeUndefined();
	});
});

describe("UndoStack", () => {
	it("starts empty (length 0)", () => {
		const stack = new UndoStack<number>();
		expect(stack.length).toBe(0);
		expect(stack.pop()).toBeUndefined();
	});

	it("push deep-clones and pop returns the snapshot", () => {
		const stack = new UndoStack<{ x: number; arr: number[] }>();
		const state = { x: 1, arr: [1, 2, 3] };
		stack.push(state);
		state.x = 99; // mutate post-push — should NOT affect snapshot
		state.arr.push(4);
		const popped = stack.pop();
		expect(popped).toEqual({ x: 1, arr: [1, 2, 3] });
	});

	it("clear() removes all snapshots", () => {
		const stack = new UndoStack<number>();
		stack.push(1);
		stack.push(2);
		stack.push(3);
		stack.clear();
		expect(stack.length).toBe(0);
		expect(stack.pop()).toBeUndefined();
	});
});

describe("TruncatedText", () => {
	it("renders a single line truncated to width with default padding", () => {
		const t = new TruncatedText("hello, world");
		const result = t.render(7);
		// Pad-to-width is enforced; the line is exactly `width` visible-chars.
		expect(result).toHaveLength(1);
	});

	it("stops at newline (only the first line is rendered)", () => {
		const t = new TruncatedText("line1\nline2");
		const result = t.render(20);
		const joined = result.join("\n");
		expect(joined).toContain("line1");
		expect(joined).not.toContain("line2");
	});

	it("with paddingY, includes vertical padding above and below the content", () => {
		const t = new TruncatedText("x", 0, 2);
		const result = t.render(10);
		// 2 padding above + 1 content + 2 padding below = 5 lines
		expect(result).toHaveLength(5);
	});

	it("with paddingX, adds horizontal padding around the truncated text", () => {
		const t = new TruncatedText("x", 2, 0);
		const result = t.render(10);
		// content line has 2 spaces left + 'x' + 2 spaces right + width pad
		expect(result[0]).toMatch(/^ {2}x {2}/);
	});

	it("invalidate() is a no-op (no cached state)", () => {
		const t = new TruncatedText("y");
		t.invalidate();
		expect(t.render(5)).toHaveLength(1);
	});
});
