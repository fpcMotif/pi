import { describe, expect, it } from "vitest";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

/**
 * Differential rendering is the package identity (CONTEXT.md): on an update the
 * TUI must write ONLY the changed lines, a first render writes the full frame,
 * and an unchanged re-render writes nothing. These tests drive the real TUI +
 * real xterm.js VirtualTerminal and assert on the actual bytes written, not on
 * mock call counts.
 */

/** SEGMENT_RESET appended to every non-image line by applyLineResets(). */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR_SCREEN = "\x1b[2J";
const CLEAR_SCROLLBACK = "\x1b[3J";
const CLEAR_LINE = "\x1b[2K";

/** A real Component whose line array can be swapped between renders. */
class MutableComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		// Return a copy so the TUI's previousLines snapshot is never aliased.
		return [...this.lines];
	}
	invalidate(): void {}
}

/** Captures every byte the TUI writes so we can assert the minimal-diff contract. */
class CapturingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	bytes(): string {
		return this.writes.join("");
	}
	reset(): void {
		this.writes = [];
	}
}

describe("TUI differential rendering — minimal write contract", () => {
	it("first render writes the full frame without clearing the screen", async () => {
		const terminal = new CapturingTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		component.lines = ["Alpha", "Beta", "Gamma"];
		tui.start();
		await terminal.waitForRender();

		const bytes = terminal.bytes();

		// First render assumes a clean screen: no 2J/3J clears.
		expect(bytes).not.toContain(CLEAR_SCREEN);
		expect(bytes).not.toContain(CLEAR_SCROLLBACK);
		// All three lines are emitted, joined by CRLF, inside one synchronized frame.
		expect(bytes).toContain("Alpha");
		expect(bytes).toContain("Beta");
		expect(bytes).toContain("Gamma");
		expect(bytes).toContain(SYNC_BEGIN);
		expect(bytes).toContain(SYNC_END);
		// fullRedraws counts both clearing and non-clearing full renders.
		expect(tui.fullRedraws).toBe(1);
		// On-screen result is correct.
		expect(terminal.getViewport().slice(0, 3)).toEqual(["Alpha", "Beta", "Gamma"]);

		tui.stop();
	});

	it("an unchanged re-render writes nothing to the terminal", async () => {
		const terminal = new CapturingTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		component.lines = ["Stable 0", "Stable 1", "Stable 2"];
		tui.start();
		await terminal.waitForRender();

		terminal.reset();
		const redrawsBefore = tui.fullRedraws;

		// Request a render but change nothing.
		tui.requestRender();
		await terminal.waitForRender();

		// firstChanged === -1 path: no diff buffer, no full redraw. With no cursor
		// marker present, positionHardwareCursor only ever hides the cursor, which
		// is a no-op write the diff path does not emit. So zero bytes written.
		expect(terminal.bytes()).toBe("");
		expect(tui.fullRedraws).toBe(redrawsBefore);

		tui.stop();
	});

	it("updating one middle line writes only that line, not the whole frame", async () => {
		const terminal = new CapturingTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		component.lines = ["Header", "Body A", "Footer"];
		tui.start();
		await terminal.waitForRender();

		terminal.reset();
		const redrawsBefore = tui.fullRedraws;

		// Change ONLY the middle line.
		component.lines = ["Header", "Body B", "Footer"];
		tui.requestRender();
		await terminal.waitForRender();

		const bytes = terminal.bytes();

		// Diff path, not a full redraw.
		expect(tui.fullRedraws).toBe(redrawsBefore);
		expect(bytes).not.toContain(CLEAR_SCREEN);
		expect(bytes).not.toContain(CLEAR_SCROLLBACK);

		// Only the changed line content is written.
		expect(bytes).toContain("Body B");
		// The unchanged Header and Footer must NOT be re-written.
		expect(bytes).not.toContain("Header");
		expect(bytes).not.toContain("Footer");

		// Exactly one line was cleared (one \x1b[2K) — the changed line.
		const clearCount = bytes.split(CLEAR_LINE).length - 1;
		expect(clearCount).toBe(1);

		// On-screen result reflects the update with neighbours intact.
		expect(terminal.getViewport().slice(0, 3)).toEqual(["Header", "Body B", "Footer"]);

		tui.stop();
	});

	it("diffs a contiguous changed range without touching lines above firstChanged", async () => {
		const terminal = new CapturingTerminal(40, 12);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		component.lines = ["keep-0", "keep-1", "old-2", "old-3", "keep-4"];
		tui.start();
		await terminal.waitForRender();

		terminal.reset();

		// Change lines 2 and 3 (a contiguous range). keep-4 stays the same but
		// sits between/after the changed span; the diff renders firstChanged..lastChanged.
		component.lines = ["keep-0", "keep-1", "new-2", "new-3", "keep-4"];
		tui.requestRender();
		await terminal.waitForRender();

		const bytes = terminal.bytes();

		// Lines above the first change are never re-written.
		expect(bytes).not.toContain("keep-0");
		expect(bytes).not.toContain("keep-1");
		// Changed lines are written.
		expect(bytes).toContain("new-2");
		expect(bytes).toContain("new-3");
		// keep-4 is after the last changed index, so it must not be rewritten.
		expect(bytes).not.toContain("keep-4");

		// Two cleared lines for the two changed rows.
		const clearCount = bytes.split(CLEAR_LINE).length - 1;
		expect(clearCount).toBe(2);

		expect(terminal.getViewport().slice(0, 5)).toEqual(["keep-0", "keep-1", "new-2", "new-3", "keep-4"]);

		tui.stop();
	});

	it("non-adjacent changes write the spanning range but skip a leading unchanged prefix", async () => {
		const terminal = new CapturingTerminal(40, 12);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		component.lines = ["p0", "p1", "m2", "k3", "m4", "k5"];
		tui.start();
		await terminal.waitForRender();

		terminal.reset();

		// Change indices 2 and 4 (non-adjacent). firstChanged=2, lastChanged=4.
		// k3 (index 3) is between them and will be re-written as part of the span,
		// but the leading prefix p0/p1 must be untouched.
		component.lines = ["p0", "p1", "M2", "k3", "M4", "k5"];
		tui.requestRender();
		await terminal.waitForRender();

		const bytes = terminal.bytes();

		// Leading unchanged prefix is never re-written.
		expect(bytes).not.toContain("p0");
		expect(bytes).not.toContain("p1");
		// Trailing unchanged line beyond lastChanged is never re-written.
		expect(bytes).not.toContain("k5");
		// The full changed span (indices 2..4) is written, including the unchanged
		// middle line k3 that falls inside the range.
		expect(bytes).toContain("M2");
		expect(bytes).toContain("k3");
		expect(bytes).toContain("M4");

		// Three lines in the span => three \x1b[2K clears.
		const clearCount = bytes.split(CLEAR_LINE).length - 1;
		expect(clearCount).toBe(3);

		expect(terminal.getViewport().slice(0, 6)).toEqual(["p0", "p1", "M2", "k3", "M4", "k5"]);

		tui.stop();
	});

	it("each diffed line carries a style reset to prevent ANSI leak into following lines", async () => {
		const terminal = new CapturingTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		component.lines = ["plain", "plain", "plain"];
		tui.start();
		await terminal.waitForRender();

		terminal.reset();

		// Introduce an unterminated bold sequence on the middle line.
		component.lines = ["plain", "\x1b[1mbold", "plain"];
		tui.requestRender();
		await terminal.waitForRender();

		const bytes = terminal.bytes();
		// applyLineResets appends SEGMENT_RESET to every non-image rendered line so
		// styling cannot bleed past the line boundary in the diff write.
		expect(bytes).toContain(`\x1b[1mbold${SEGMENT_RESET}`);

		tui.stop();
	});
});

describe("TUI differential rendering — throughput / latency", () => {
	it("a burst of single-line frame updates stays bounded and never redraws the whole screen", async () => {
		const terminal = new CapturingTerminal(60, 20);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		// A realistic layout: stable header/footer with a single animating line.
		const header = "=== status ===";
		const footer = "press q to quit";
		component.lines = [header, "frame 0", footer];
		tui.start();
		await terminal.waitForRender();

		terminal.reset();
		const redrawsBefore = tui.fullRedraws;

		const FRAMES = 60;
		const start = performance.now();
		for (let i = 1; i <= FRAMES; i++) {
			component.lines = [header, `frame ${i}`, footer];
			tui.requestRender();
			// Settle each frame so the diff actually runs per update (throttled to 16ms).
			await terminal.waitForRender();
		}
		const elapsed = performance.now() - start;

		const bytes = terminal.bytes();

		// No full redraw happened across the entire burst — pure differential path.
		expect(tui.fullRedraws).toBe(redrawsBefore);
		expect(bytes).not.toContain(CLEAR_SCREEN);
		expect(bytes).not.toContain(CLEAR_SCROLLBACK);

		// The stable header/footer are written zero times during the burst.
		// (header/footer appear once in the initial frame, but that is before reset.)
		expect(bytes.split(header).length - 1).toBe(0);
		expect(bytes.split(footer).length - 1).toBe(0);

		// Exactly one animating line is cleared per settled frame: precisely one 2K
		// per frame. Pinning the count (not just an upper bound) also catches a
		// regression that drops or doubles per-line clears.
		const clearCount = bytes.split(CLEAR_LINE).length - 1;
		expect(clearCount).toBe(FRAMES);

		// Bounded write volume: a whole-screen redraw of a 60x20 frame each time
		// would be on the order of FRAMES * 20 * 60 bytes. Assert we wrote far less.
		const wholeScreenEachFrame = FRAMES * terminal.rows * terminal.columns;
		expect(bytes.length).toBeLessThan(wholeScreenEachFrame / 4);

		// The final frame is on screen and earlier frame numbers are gone.
		const viewport = terminal.getViewport();
		expect(viewport[0]).toBe(header);
		expect(viewport[1]).toBe(`frame ${FRAMES}`);
		expect(viewport[2]).toBe(footer);

		// Latency sanity: 60 settled frames should complete well under the 30s test budget.
		expect(elapsed).toBeLessThan(5000);

		tui.stop();
	});

	it("coalesces multiple synchronous updates within the throttle window into one diff", async () => {
		const terminal = new CapturingTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);

		component.lines = ["row", "row", "row"];
		tui.start();
		await terminal.waitForRender();

		terminal.reset();
		const writesBefore = terminal.writes.length;

		// Fire several updates back-to-back without yielding. The 16ms throttle
		// should collapse them so only the final state is drawn once.
		for (let i = 0; i < 8; i++) {
			component.lines = ["row", `mut ${i}`, "row"];
			tui.requestRender();
		}
		await terminal.waitForRender();

		// Far fewer write batches than requestRender calls (coalesced to ~1 diff frame).
		const writeBatches = terminal.writes.length - writesBefore;
		expect(writeBatches).toBeGreaterThan(0);
		expect(writeBatches).toBeLessThanOrEqual(2);

		// Only the latest value is on screen.
		expect(terminal.getViewport()[1]).toBe("mut 7");
		// No intermediate value (mut 0..6) ever reached the terminal — only the
		// final state was drawn. Asserting every dropped frame, not a sample.
		const bytes = terminal.bytes();
		for (let i = 0; i < 7; i++) {
			expect(bytes).not.toContain(`mut ${i}`);
		}
		expect(bytes).toContain("mut 7");

		tui.stop();
	});
});
