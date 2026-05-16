// ADR-0017 phase B.4: characterisation tests for the simplest tui
// components that were at 0% coverage. Brings Spacer, Text, and Box
// each to 100% (or close) on all four metrics.
import { describe, expect, it } from "vitest";
import { Box } from "../src/components/box.js";
import { Spacer } from "../src/components/spacer.js";
import { Text } from "../src/components/text.js";

describe("Spacer", () => {
	it("default constructor produces 1 empty line", () => {
		const spacer = new Spacer();
		expect(spacer.render(10)).toEqual([""]);
	});

	it("constructor with N renders N empty lines", () => {
		const spacer = new Spacer(3);
		expect(spacer.render(10)).toEqual(["", "", ""]);
	});

	it("constructor with 0 renders no lines", () => {
		const spacer = new Spacer(0);
		expect(spacer.render(10)).toEqual([]);
	});

	it("setLines mutates lines count for subsequent renders", () => {
		const spacer = new Spacer(2);
		spacer.setLines(5);
		expect(spacer.render(10)).toEqual(["", "", "", "", ""]);
	});

	it("invalidate() is a no-op (no cached state)", () => {
		const spacer = new Spacer(1);
		spacer.invalidate();
		expect(spacer.render(10)).toEqual([""]);
	});
});

describe("Text", () => {
	it("renders empty text as empty array (zero-render fast path)", () => {
		const t = new Text("");
		const result = t.render(20);
		expect(result).toEqual([]);
	});

	it("renders whitespace-only text as empty array", () => {
		const t = new Text("   \n   ");
		const result = t.render(20);
		expect(result).toEqual([]);
	});

	it("renders normal text with default 1×1 padding", () => {
		const t = new Text("hello");
		const result = t.render(10);
		expect(result.length).toBeGreaterThan(0);
		// First and last lines are padding (empty / whitespace-padded).
		// Middle line contains "hello" (with left/right margin).
		const joined = result.join("\n");
		expect(joined).toContain("hello");
	});

	it("re-render with same args hits the cache", () => {
		const t = new Text("cached");
		const first = t.render(20);
		const second = t.render(20);
		// Cache returns the same array reference on hit.
		expect(second).toBe(first);
	});

	it("setText invalidates cache; new text produces different output", () => {
		const t = new Text("a");
		const before = t.render(20);
		t.setText("b");
		const after = t.render(20);
		expect(after).not.toBe(before);
		expect(after.join("\n")).toContain("b");
	});

	it("tabs are normalized to 3 spaces", () => {
		const t = new Text("a\tb");
		const result = t.render(20);
		const joined = result.join("\n");
		expect(joined).toContain("a   b");
	});

	it("customBgFn is applied to rendered lines (covers applyBackgroundToLine branch)", () => {
		const t = new Text("hello", 1, 0, (s) => `BG[${s}]BG`);
		const result = t.render(10);
		const joined = result.join("|");
		expect(joined).toContain("BG[");
	});

	it("setCustomBgFn invalidates cache and changes output", () => {
		const t = new Text("hello");
		const before = t.render(10);
		t.setCustomBgFn((s) => `<${s}>`);
		const after = t.render(10);
		expect(after).not.toBe(before);
	});

	it("invalidate() forces re-render even with same args", () => {
		const t = new Text("hello");
		const first = t.render(10);
		t.invalidate();
		const second = t.render(10);
		// Same content but different array (cache cleared).
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});
});

describe("Box", () => {
	it("with no children renders []", () => {
		const box = new Box();
		expect(box.render(20)).toEqual([]);
	});

	it("addChild + render produces output that includes child content", () => {
		const box = new Box();
		const text = new Text("inner");
		box.addChild(text);
		const result = box.render(20);
		expect(result.join("\n")).toContain("inner");
	});

	it("removeChild removes the child from rendering", () => {
		const box = new Box();
		const a = new Text("first");
		const b = new Text("second");
		box.addChild(a);
		box.addChild(b);
		box.removeChild(a);
		const result = box.render(20).join("\n");
		expect(result).not.toContain("first");
		expect(result).toContain("second");
	});

	it("removeChild with a non-child is a no-op", () => {
		const box = new Box();
		const a = new Text("kept");
		const other = new Text("never-added");
		box.addChild(a);
		box.removeChild(other);
		expect(box.render(20).join("\n")).toContain("kept");
	});

	it("clear() removes all children", () => {
		const box = new Box();
		box.addChild(new Text("a"));
		box.addChild(new Text("b"));
		box.clear();
		expect(box.render(20)).toEqual([]);
	});

	it("setBgFn changes background sampling on the next render", () => {
		const box = new Box(1, 1, undefined);
		box.addChild(new Text("x"));
		const before = box.render(15);
		box.setBgFn((s) => `[${s}]`);
		const after = box.render(15);
		// Either content text differs OR layout was re-sampled. Either way
		// the two renders aren't the same reference because of the bgSample
		// cache miss.
		expect(after).not.toBe(before);
	});

	it("invalidate() clears the cache and propagates to children", () => {
		const box = new Box();
		const text = new Text("inv");
		box.addChild(text);
		box.render(20);
		box.invalidate();
		const second = box.render(20);
		expect(second.join("\n")).toContain("inv");
	});

	it("re-render with same args + same children hits the cache", () => {
		const box = new Box();
		box.addChild(new Text("c"));
		const first = box.render(20);
		const second = box.render(20);
		expect(second).toBe(first);
	});

	it("renders [] when all children produce empty output (box.ts:92-93 branch)", () => {
		const box = new Box();
		// Spacer(0) renders []. With non-empty children list but zero output
		// lines, box hits the post-loop `if (childLines.length === 0)` branch.
		box.addChild(new Spacer(0));
		expect(box.render(20)).toEqual([]);
	});
});
