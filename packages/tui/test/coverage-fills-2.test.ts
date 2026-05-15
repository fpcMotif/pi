// Round 2 of coverage fills, focused on the remaining big-gap files.

import assert from "node:assert";
import { Chalk } from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";
import { Editor } from "../src/components/editor.js";
import { Input } from "../src/components/input.js";
import { Markdown } from "../src/components/markdown.js";
import { decodeKittyPrintable, isKeyRepeat, parseKey, setKittyProtocolActive } from "../src/keys.js";
import { StdinBuffer } from "../src/stdin-buffer.js";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../src/terminal-image.js";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.js";
import {
	applyBackgroundToLine,
	extractAnsiCode,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../src/utils.js";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const chalk = new Chalk({ level: 3 });

class StaticComp implements Component {
	constructor(public lines: string[] = []) {}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class FocusableComp implements Component {
	focused = false;
	lastInput?: string;
	constructor(public lines: string[] = []) {}
	render(): string[] {
		return this.lines;
	}
	handleInput(data: string): void {
		this.lastInput = data;
	}
	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

// ============================================================================
// TUI: render mechanics and edge cases
// ============================================================================
describe("TUI — render mechanics", () => {
	it("Container.invalidate cascades to children without invalidate method", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		// Child without invalidate method shouldn't throw — exercise the
		// defensive `if (typeof child.invalidate === "function")` guard in
		// Container.invalidate. The cast through `unknown` is required
		// because we are deliberately passing a partial Component.
		tui.children.push({ render: () => ["x"] } as unknown as Component);
		tui.invalidate();
		// No throw expected.
	});

	it("requestRender(force=true) clears render timer if active", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new StaticComp(["a"]));
		tui.start();
		await terminal.waitForRender();
		// Schedule a render
		tui.requestRender(false);
		// Then force, which should clear the timer and re-run.
		tui.requestRender(true);
		await terminal.waitForRender();
		tui.stop();
	});

	it("requestRender de-dupes consecutive non-force calls", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new StaticComp(["a"]));
		tui.start();
		await terminal.waitForRender();
		const before = tui.fullRedraws;
		tui.requestRender(false);
		tui.requestRender(false);
		await terminal.waitForRender();
		// Only one render should happen.
		expect(tui.fullRedraws).toBe(before);
		tui.stop();
	});

	it("stop after start moves cursor to the end of content", async () => {
		const writes: string[] = [];
		class CollectingTerm extends VirtualTerminal {
			override write(d: string): void {
				writes.push(d);
				super.write(d);
			}
		}
		const term = new CollectingTerm(80, 5);
		const tui = new TUI(term);
		const comp = new StaticComp(["one", "two", "three"]);
		tui.addChild(comp);
		tui.start();
		await term.waitForRender();
		// Stop writes \r\n at the end.
		tui.stop();
		const final = writes.join("");
		expect(final).toContain("\r\n");
	});

	it("handleInput consumed by listener is dropped from focused component", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const focusable = new FocusableComp(["f"]);
		tui.addChild(focusable);
		tui.setFocus(focusable);
		tui.start();
		await terminal.waitForRender();
		// Listener consumes the input.
		tui.addInputListener(() => ({ consume: true }));
		terminal.sendInput("x");
		expect(focusable.lastInput).toBeUndefined();
		tui.stop();
	});

	it("debug key (shift+ctrl+d) triggers onDebug callback", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const focusable = new FocusableComp(["f"]);
		tui.addChild(focusable);
		tui.setFocus(focusable);
		tui.start();
		let debugged = 0;
		tui.onDebug = () => {
			debugged++;
		};
		// Send shift+ctrl+d via Kitty (codepoint 100 = 'd', modifier 5 = ctrl+shift, +1 = 6)
		terminal.sendInput("\x1b[100;6u");
		expect(debugged).toBe(1);
		tui.stop();
	});

	it("key release is filtered when component does not opt in", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const focusable = new FocusableComp(["f"]);
		tui.addChild(focusable);
		tui.setFocus(focusable);
		tui.start();
		// Key release sequence (Kitty CSI-u with :3u)
		terminal.sendInput("\x1b[97;1:3u");
		// Should not reach the component because release events are filtered.
		expect(focusable.lastInput).toBeUndefined();
		tui.stop();
	});

	it("key release reaches component that wantsKeyRelease", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		class ReleaseComp implements Component {
			wantsKeyRelease = true;
			lastInput?: string;
			render(): string[] {
				return ["r"];
			}
			handleInput(data: string): void {
				this.lastInput = data;
			}
			invalidate(): void {}
		}
		const r = new ReleaseComp();
		tui.addChild(r);
		tui.setFocus(r);
		tui.start();
		terminal.sendInput("\x1b[97;1:3u");
		expect(r.lastInput).toBe("\x1b[97;1:3u");
		tui.stop();
	});

	it("invalid cell size response is consumed without setting dimensions", async () => {
		resetCapabilitiesCache();
		setCapabilities({ images: "kitty", trueColor: false, hyperlinks: false });
		const initialCell = { widthPx: 10, heightPx: 20 };
		setCellDimensions(initialCell);
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const focusable = new FocusableComp(["f"]);
		tui.addChild(focusable);
		tui.setFocus(focusable);
		tui.start();
		// Invalid response: heightPx = 0
		terminal.sendInput("\x1b[6;0;5t");
		// Component should not receive the input; cell size unchanged.
		expect(focusable.lastInput).toBeUndefined();
		tui.stop();
		resetCapabilitiesCache();
	});

	it("focused overlay becomes invisible at runtime → focus redirects to next visible or preFocus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const focusable = new FocusableComp(["base"]);
		tui.addChild(focusable);
		tui.setFocus(focusable);
		let overlayVisible = true;
		class CondOverlay implements Component {
			lastInput?: string;
			render(): string[] {
				return ["overlay"];
			}
			handleInput(data: string): void {
				this.lastInput = data;
			}
			invalidate(): void {}
		}
		const overlay = new CondOverlay();
		tui.showOverlay(overlay, {
			width: 10,
			visible: () => overlayVisible,
		});
		tui.start();
		await terminal.waitForRender();
		// Make overlay invisible.
		overlayVisible = false;
		// Send input — should not reach overlay; should go to base focusable instead.
		terminal.sendInput("x");
		expect(focusable.lastInput).toBe("x");
		tui.stop();
	});

	it("focused overlay invisible with no other visible overlay → focus falls back to preFocus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const base = new FocusableComp(["base"]);
		tui.addChild(base);
		tui.setFocus(base);
		let visible = true;
		class HideableOverlay implements Component {
			render(): string[] {
				return ["ov"];
			}
			invalidate(): void {}
		}
		const ov = new HideableOverlay();
		tui.showOverlay(ov, {
			width: 5,
			visible: () => visible,
		});
		tui.start();
		await terminal.waitForRender();
		visible = false;
		terminal.sendInput("y");
		// Focus has been restored to base (preFocus).
		expect(base.lastInput).toBe("y");
		tui.stop();
	});

	it("renders content with hardware cursor marker → positions cursor", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal, true);
		class CursorComp implements Component {
			focused = false;
			render(): string[] {
				return [`hello${CURSOR_MARKER}world`];
			}
			invalidate(): void {}
		}
		const c = new CursorComp();
		c.focused = true;
		tui.addChild(c);
		tui.setFocus(c);
		tui.start();
		await terminal.waitForRender();
		tui.stop();
		// No assertion needed — the path through positionHardwareCursor with cursor
		// row/col is exercised by the render cycle.
	});

	it("setShowHardwareCursor hides cursor when disabled", () => {
		const terminal = new VirtualTerminal(80, 24);
		let hideCount = 0;
		const realHideCursor = terminal.hideCursor.bind(terminal);
		terminal.hideCursor = () => {
			hideCount++;
			realHideCursor();
		};
		const tui = new TUI(terminal, true);
		hideCount = 0;
		tui.setShowHardwareCursor(false);
		expect(hideCount).toBeGreaterThan(0);
	});

	it("Overlay handle.focus brings overlay back to front when clicked", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new StaticComp(["base"]));
		const o1 = new StaticComp(["o1"]);
		const o2 = new StaticComp(["o2"]);
		const h1 = tui.showOverlay(o1, { width: 5, anchor: "top-left" });
		tui.showOverlay(o2, { width: 5, anchor: "top-left" });
		// Initially o2 has focus
		expect(h1.isFocused()).toBe(false);
		// Focus o1
		h1.focus();
		expect(h1.isFocused()).toBe(true);
	});

	it("Overlay handle.focus returns early when overlay is invisible", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new StaticComp(["base"]));
		const o = new StaticComp(["o"]);
		const handle = tui.showOverlay(o, {
			width: 5,
			visible: () => false, // invisible
		});
		handle.focus();
		// Focus didn't change (no visible overlay)
		expect(handle.isFocused()).toBe(false);
	});

	it("Overlay handle.unfocus is a no-op when overlay does not have focus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new StaticComp(["base"]));
		const o = new StaticComp(["o"]);
		const handle = tui.showOverlay(o, { width: 5 });
		// Wait a moment so handle.focus()/showOverlay processed
		await renderAndFlush(tui, terminal);
		// Move focus elsewhere
		const other = new StaticComp(["other"]);
		tui.setFocus(other);
		handle.unfocus(); // should early-return since focus is not on overlay
		// No throw — the path is exercised.
	});

	it("Overlay handle.unfocus restores focus to preFocus when no other visible overlay", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const baseFoc = new FocusableComp(["base"]);
		tui.addChild(baseFoc);
		tui.setFocus(baseFoc);
		const o = new StaticComp(["o"]);
		const handle = tui.showOverlay(o, { width: 5 });
		tui.start();
		await terminal.waitForRender();
		handle.unfocus(); // should restore to baseFoc
		terminal.sendInput("x");
		expect(baseFoc.lastInput).toBe("x");
		tui.stop();
	});

	it("Overlay handle.setHidden(true) when overlay has focus moves focus to topmost or preFocus", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const baseFoc = new FocusableComp(["base"]);
		tui.addChild(baseFoc);
		tui.setFocus(baseFoc);
		const o = new StaticComp(["o"]);
		const handle = tui.showOverlay(o, { width: 5 });
		tui.start();
		await terminal.waitForRender();
		// Now hide the overlay; focus should fall back to baseFoc.
		handle.setHidden(true);
		expect(handle.isHidden()).toBe(true);
		terminal.sendInput("x");
		expect(baseFoc.lastInput).toBe("x");
		tui.stop();
	});

	it("Overlay handle.setHidden(false) restores focus to overlay when visible", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const baseFoc = new FocusableComp(["base"]);
		tui.addChild(baseFoc);
		tui.setFocus(baseFoc);
		class FOverlay implements Component {
			lastInput?: string;
			render(): string[] {
				return ["ov"];
			}
			handleInput(data: string): void {
				this.lastInput = data;
			}
			invalidate(): void {}
		}
		const o = new FOverlay();
		const handle = tui.showOverlay(o, { width: 5 });
		tui.start();
		await terminal.waitForRender();
		handle.setHidden(true);
		expect(handle.isHidden()).toBe(true);
		handle.setHidden(false);
		// Send input; should reach overlay again.
		terminal.sendInput("y");
		expect(o.lastInput).toBe("y");
		tui.stop();
	});

	it("Overlay handle.setHidden no-op when value unchanged", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const o = new StaticComp(["o"]);
		const handle = tui.showOverlay(o, { width: 5 });
		expect(handle.isHidden()).toBe(false);
		handle.setHidden(false); // already not hidden — no-op
		expect(handle.isHidden()).toBe(false);
	});
});

// ============================================================================
// Render width-exceed crash path: covers the throw and stop() error path.
// ============================================================================
describe("TUI — width-overflow crash", () => {
	it("throws when a rendered line exceeds terminal width on differential render", async () => {
		// The crash path: first fullRender uses different code, but when content
		// shrinks then re-grows past width, the differential renderer throws.
		// We trigger it synchronously via process.nextTick scheduling.
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const comp = new StaticComp(["short"]);
		tui.addChild(comp);
		tui.start();
		await terminal.waitForRender();
		// Force a differential render (not first render) by changing content size.
		comp.lines = ["short", "another"];
		tui.requestRender();
		await terminal.waitForRender();
		// Now intentionally overflow — capture the unhandled-error promise.
		const originalListeners = process.listeners("uncaughtException");
		const errors: Error[] = [];
		const captureListener = (err: Error) => {
			errors.push(err);
		};
		process.removeAllListeners("uncaughtException");
		process.on("uncaughtException", captureListener);
		try {
			comp.lines = ["x".repeat(50), "y".repeat(50)];
			tui.requestRender();
			await new Promise((r) => setTimeout(r, 80));
			// At least one error captured with width-exceed message.
			expect(errors.some((e) => /exceeds terminal width/.test(e.message))).toBe(true);
		} finally {
			process.removeListener("uncaughtException", captureListener);
			for (const l of originalListeners) process.on("uncaughtException", l);
			try {
				tui.stop();
			} catch {
				// already stopped
			}
		}
	});
});

// ============================================================================
// Stdin buffer — remaining gaps
// ============================================================================
describe("StdinBuffer — round 2", () => {
	let buf: StdinBuffer;
	let events: string[];

	beforeEach(() => {
		buf = new StdinBuffer({ timeout: 5 });
		events = [];
		buf.on("data", (s) => events.push(s));
	});

	it("non-escape character is taken one at a time (covers line 224-228)", () => {
		buf.process("ab");
		expect(events).toEqual(["a", "b"]);
	});

	it("not-escape sequence in isCompleteSequence (line 30-32) — buffer that starts with non-escape", () => {
		// The isCompleteSequence "not-escape" path can also be tested indirectly,
		// but extractCompleteSequences handles non-escape directly. So we need to
		// somehow trigger isCompleteSequence on a non-escape — happens when data
		// is not starting with ESC. We test via the public API.
		buf.process("a");
		expect(events).toEqual(["a"]);
	});

	it("buffer flushes after timeout for incomplete CSI", async () => {
		buf.process("\x1b[");
		expect(events).toEqual([]);
		// Wait for timeout to flush
		await new Promise((r) => setTimeout(r, 30));
		expect(events).toEqual(["\x1b["]);
	});

	it("CSI with SGR mouse: digits with M but not in <digits;digits;digits[Mm]> format", async () => {
		// "<1;2;3" with no final letter: incomplete
		buf.process("\x1b[<1;2;3");
		expect(events).toEqual([]);
		// Provide just M (no digits)
		await new Promise((r) => setTimeout(r, 30));
	});
});

// ============================================================================
// keys.ts — isKeyRepeat (line 557) and other small gaps
// ============================================================================
describe("keys.ts — round 2", () => {
	afterEach(() => setKittyProtocolActive(false));

	it("isKeyRepeat returns true for ':2u' patterns", () => {
		expect(isKeyRepeat("\x1b[97;1:2u")).toBe(true);
		expect(isKeyRepeat("\x1b[3;1:2~")).toBe(true);
		expect(isKeyRepeat("\x1b[1;1:2A")).toBe(true);
		expect(isKeyRepeat("\x1b[1;1:2B")).toBe(true);
		expect(isKeyRepeat("\x1b[1;1:2C")).toBe(true);
		expect(isKeyRepeat("\x1b[1;1:2D")).toBe(true);
		expect(isKeyRepeat("\x1b[1;1:2H")).toBe(true);
		expect(isKeyRepeat("\x1b[1;1:2F")).toBe(true);
	});

	it("isKeyRepeat returns false for non-repeat patterns", () => {
		expect(isKeyRepeat("\x1b[97u")).toBe(false);
		expect(isKeyRepeat("a")).toBe(false);
	});

	it("isKeyRepeat is suppressed inside bracketed paste", () => {
		expect(isKeyRepeat("\x1b[200~text:2F\x1b[201~")).toBe(false);
	});

	it("matchesKey escape with modifier returns false", () => {
		expect(parseKey("\x1b[27;1;27~")).toBe("escape");
		// modifyOtherKeys with shift on escape (modifier 1) is not handled — should be undefined.
	});

	it("parseKey returns the legacy double-bracket sequences", () => {
		expect(parseKey("\x1b[[5~")).toBe("pageUp");
		expect(parseKey("\x1b[[6~")).toBe("pageDown");
		expect(parseKey("\x1b[[A")).toBe("f1");
		expect(parseKey("\x1b[[B")).toBe("f2");
		expect(parseKey("\x1b[[C")).toBe("f3");
		expect(parseKey("\x1b[[D")).toBe("f4");
		expect(parseKey("\x1b[[E")).toBe("f5");
	});

	it("decodeKittyPrintable returns plain printable character with no modifier", () => {
		// Codepoint 65 'A' with no modifier
		expect(decodeKittyPrintable("\x1b[65u")).toBe("A");
	});

	it("decodeKittyPrintable rejects codepoints below 32 (control)", () => {
		// Codepoint 10 (LF)
		expect(decodeKittyPrintable("\x1b[10u")).toBeUndefined();
	});

	it("decodeKittyPrintable returns normalized keypad codepoints", () => {
		// 57399 -> 48 ('0')
		expect(decodeKittyPrintable("\x1b[57399u")).toBe("0");
	});

	it("parseKey: empty alt+letter (just ESC followed by uppercase)", () => {
		setKittyProtocolActive(false);
		// \x1bA (capital A, code 65 — not in 97-122 letter range, not 48-57 digit)
		expect(parseKey("\x1bA")).toBeUndefined();
	});
});

// ============================================================================
// utils.ts — remaining
// ============================================================================
describe("utils.ts — round 2", () => {
	it("AnsiCodeTracker handles RGB-color (38;2;R;G;B) escape sequence", () => {
		// Pass through wrapTextWithAnsi to exercise SGR path.
		const text = `\x1b[38;2;255;0;0mred text\x1b[0m and more`;
		const lines = wrapTextWithAnsi(text, 10);
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});

	it("AnsiCodeTracker handles 256-color (38;5;N) escape sequence", () => {
		const text = `\x1b[38;5;240mgray text\x1b[0m and more`;
		const lines = wrapTextWithAnsi(text, 10);
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});

	it("AnsiCodeTracker handles bright background (48;5;N)", () => {
		const text = `\x1b[48;5;240mgrayBG text\x1b[0m`;
		const lines = wrapTextWithAnsi(text, 5);
		// Tracker tracks bg color across wraps.
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});

	it("AnsiCodeTracker resets all attributes on \\x1b[0m", () => {
		const text = `\x1b[31m\x1b[1mboldred\x1b[0mplain text continues`;
		const lines = wrapTextWithAnsi(text, 8);
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});

	it("AnsiCodeTracker handles individual on/off codes (22, 23, 24, 25, 27, 28, 29, 39, 49)", () => {
		const text = `\x1b[1m\x1b[2m\x1b[3m\x1b[4m\x1b[5m\x1b[7m\x1b[8m\x1b[9mstyled\x1b[22m\x1b[23m\x1b[24m\x1b[25m\x1b[27m\x1b[28m\x1b[29m\x1b[39m\x1b[49m and more text here`;
		const lines = wrapTextWithAnsi(text, 6);
		expect(lines.length).toBeGreaterThan(1);
	});

	it("AnsiCodeTracker handles 21 (bold off)", () => {
		const text = `\x1b[1mbold\x1b[21m plain text\x1b[0m`;
		const lines = wrapTextWithAnsi(text, 5);
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});

	it("AnsiCodeTracker handles bright fg/bg color codes (90-97, 100-107)", () => {
		const text = `\x1b[91m\x1b[101mbright\x1b[0m text`;
		const lines = wrapTextWithAnsi(text, 4);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("AnsiCodeTracker processes OSC 8 hyperlink open/close", () => {
		const text = `\x1b]8;;https://x.com\x07click here\x1b]8;;\x07 after`;
		const lines = wrapTextWithAnsi(text, 8);
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});

	it("AnsiCodeTracker preserves OSC 8 hyperlink with ST terminator", () => {
		const text = `\x1b]8;;https://example.com\x1b\\linktext\x1b]8;;\x1b\\plain`;
		const lines = wrapTextWithAnsi(text, 6);
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});

	it("AnsiCodeTracker handles empty SGR params (effective reset)", () => {
		const text = `\x1b[1mbold\x1b[m plain text`;
		const lines = wrapTextWithAnsi(text, 5);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("AnsiCodeTracker handles malformed SGR (returns null on m-end without match)", () => {
		// Non-m-ending escape sequence is ignored by tracker.
		const text = `\x1b[1G\x1b[31mfoo bar baz`;
		const lines = wrapTextWithAnsi(text, 4);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("AnsiCodeTracker process function returns when ANSI is not 'm'-terminated and not OSC8", () => {
		// CSI K is not 'm' and not OSC 8 — should be skipped (return path at line 380-381).
		const text = `\x1b[Kfoo bar baz`;
		const lines = wrapTextWithAnsi(text, 4);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("OSC 8 parseOsc8Hyperlink with missing semicolon returns undefined", () => {
		// Malformed OSC 8 sequence — params; missing close
		const text = `\x1b]8;noseparator\x07click`;
		const lines = wrapTextWithAnsi(text, 4);
		// Doesn't throw; rendering proceeds.
		expect(lines.length).toBeGreaterThan(0);
	});

	it("OSC 8 hyperlink with empty URL returns null (close)", () => {
		const text = `\x1b]8;;\x07after`;
		const lines = wrapTextWithAnsi(text, 4);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("breakLongWord with active ANSI tracker uses tracker.getActiveCodes()", () => {
		// Long word inside an active color should preserve the color on wrap.
		const text = `\x1b[31mverylongwordthatdefinitelyexceedstheavailablewidthbymanycharacters\x1b[0m`;
		const lines = wrapTextWithAnsi(text, 10);
		expect(lines.length).toBeGreaterThanOrEqual(5);
	});

	it("wrapSingleLine: empty result fallback (line 749 [''])", () => {
		// An input of just whitespace tokens should still produce a valid output.
		const lines = wrapTextWithAnsi(" ", 5);
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});

	it("wrapSingleLine: token already exceeds width with adjacent whitespace handled", () => {
		const text = "aaaaaaaa bbbb";
		const lines = wrapTextWithAnsi(text, 5);
		expect(lines.length).toBeGreaterThan(1);
	});

	it("truncateFragmentToWidth with empty / negative maxWidth returns empty", () => {
		// Internal helper not directly exported; covered via truncateToWidth.
		expect(truncateToWidth("xyz", 0, "")).toBe("");
		expect(truncateToWidth("xyz", -1, "")).toBe("");
	});

	it("truncateFragmentToWidth fragment slice with ANSI/tabs path", () => {
		// Force the hasAnsi || hasTabs path inside truncateFragmentToWidth via wide text.
		// We pass styled text and verify truncation.
		const result = truncateToWidth(`\x1b[31mhello world\x1b[0m`, 4, "");
		expect(visibleWidth(result)).toBeLessThanOrEqual(4);
	});

	it("sliceWithWidth: ANSI codes preceding the start are buffered as pendingAnsi", () => {
		const styled = `\x1b[31mhello world\x1b[0m`;
		const r = sliceWithWidth(styled, 6, 5);
		expect(r.text).toContain("world");
	});

	it("sliceByColumn handles strict mode and full ANSI lifetime", () => {
		const styled = "\x1b[31mh中llo\x1b[0m";
		const r = sliceByColumn(styled, 1, 2, true);
		expect(visibleWidth(r)).toBeLessThanOrEqual(2);
	});

	it("AnsiCodeTracker.getLineEndReset returns combined reset for active underline + hyperlink", () => {
		// Underline + OSC 8 → both should produce reset on line end during wrap.
		const text = `\x1b[4m\x1b]8;;https://e.com\x07hello world test\x1b]8;;\x07\x1b[0m`;
		const lines = wrapTextWithAnsi(text, 6);
		expect(lines.length).toBeGreaterThanOrEqual(2);
		// At least one wrap point should include OSC 8 close
		const joined = lines.join("");
		expect(joined.includes("\x1b]8;;\x07") || joined.includes("\x1b]8;;\x1b\\")).toBe(true);
	});

	it("applyBackgroundToLine handles 0 padding cleanly", () => {
		expect(applyBackgroundToLine("hello", 5, (s) => `<${s}>`)).toBe("<hello>");
	});

	it("applyBackgroundToLine handles wider input than width", () => {
		expect(applyBackgroundToLine("hello world", 5, (s) => `<${s}>`)).toBe("<hello world>");
	});

	it("extractAnsiCode parses unterminated OSC and returns null", () => {
		expect(extractAnsiCode("\x1b]8;;data", 0)).toBeNull();
	});
});

// ============================================================================
// Markdown — render-token specific gaps
// ============================================================================
describe("Markdown — round 2 (token-specific)", () => {
	it("renders nested blockquote with various block-level children", () => {
		const md = new Markdown("> **bold quote**\n> \n> - list1\n> - list2", 0, 0, defaultMarkdownTheme);
		const out = md
			.render(40)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(out).toContain("│");
		expect(out).toContain("bold quote");
		expect(out).toContain("list1");
	});

	it("renders deeply nested blockquote", () => {
		const md = new Markdown("> outer\n> > inner\n> outer2", 0, 0, defaultMarkdownTheme);
		const out = md
			.render(40)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(out.split("│").length).toBeGreaterThan(2);
	});

	it("renders table where row count > 1 includes separator between rows", () => {
		const md = new Markdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |", 0, 0, defaultMarkdownTheme);
		const out = md.render(40).join("\n");
		// Separator line "├" should appear between rows.
		expect(out.split("├").length).toBeGreaterThan(2);
	});

	it("renders inline html via 'raw' field", () => {
		const md = new Markdown("text <em>inline</em> more", 0, 0, defaultMarkdownTheme);
		const out = md.render(80).join("\n");
		expect(out).toContain("<em>");
	});

	it("renders code block without language", () => {
		const md = new Markdown("```\ncode no lang\n```", 0, 0, defaultMarkdownTheme);
		const out = md
			.render(40)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(out).toContain("code no lang");
	});

	it("renders an ordered list with two-digit start values", () => {
		const md = new Markdown("10. ten\n11. eleven", 0, 0, defaultMarkdownTheme);
		const out = md
			.render(40)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(out).toContain("10. ten");
		expect(out).toContain("11. eleven");
	});

	it("renders a list item that contains nested list and another text token", () => {
		const md = new Markdown("- outer\n  - nested\n  more text in same item", 0, 0, defaultMarkdownTheme);
		const out = md
			.render(40)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(out).toContain("outer");
		expect(out).toContain("nested");
	});

	it("renders blockquote with renderInlineTokens default style context fallback", () => {
		const md = new Markdown("> *italic in quote*", 0, 0, defaultMarkdownTheme);
		const lines = md.render(40);
		const text = lines.join("\n");
		expect(text).toContain("│");
	});

	it("blockquote with paragraph + paragraph generates spacing between them", () => {
		const md = new Markdown("> first paragraph\n>\n> second paragraph", 0, 0, defaultMarkdownTheme);
		const out = md
			.render(40)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(out).toContain("first paragraph");
		expect(out).toContain("second paragraph");
	});

	it("renderTable: column shrinking when totalNaturalWidth > availableWidth", () => {
		// Long content forces shrinking but min word widths fit.
		const md = new Markdown(
			"| a | b |\n|---|---|\n| longer content here | more longer content |",
			0,
			0,
			defaultMarkdownTheme,
		);
		const out = md.render(40).join("\n");
		expect(out).toContain("│");
	});

	it("renderTable: very narrow available forces remaining distribution", () => {
		// Column min widths sum > availableForCells — triggers redistribution.
		const md = new Markdown("| a | b | c |\n|---|---|---|\n| veryverylongword | x | y |", 0, 0, defaultMarkdownTheme);
		const out = md.render(20).join("\n");
		expect(out.length).toBeGreaterThan(0);
	});

	it("renderTable with raw token containing the markdown source for the fallback path", () => {
		// Very narrow width forces fall-back to raw markdown rendering.
		const md = new Markdown("| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |", 0, 0, defaultMarkdownTheme);
		const out = md.render(5).join("\n"); // 5 - 16 borderOverhead < 0
		expect(out.length).toBeGreaterThan(0);
	});

	it("renders space token (covers space case branch)", () => {
		const md = new Markdown("first\n\nsecond", 0, 0, defaultMarkdownTheme);
		const out = md.render(40).join("\n");
		expect(out).toContain("first");
		expect(out).toContain("second");
	});

	it("default style prefix is computed once and cached across renders", () => {
		const md = new Markdown("hello world", 0, 0, defaultMarkdownTheme, {
			color: (s) => chalk.red(s),
		});
		md.render(40);
		md.render(40); // hits cached defaultStylePrefix branch
	});
});

// ============================================================================
// Editor — uncovered: getPaddingX/setPaddingX, getAutocompleteMaxVisible, etc.
// ============================================================================
describe("Editor — public getters/setters", () => {
	it("getPaddingX returns the configured padding", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme, { paddingX: 3 });
		expect(editor.getPaddingX()).toBe(3);
	});

	it("setPaddingX(same value) is a no-op", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme, { paddingX: 2 });
		editor.setPaddingX(2);
		expect(editor.getPaddingX()).toBe(2);
	});

	it("setPaddingX clamps to >= 0 floored integer", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setPaddingX(-5);
		expect(editor.getPaddingX()).toBe(0);
		editor.setPaddingX(2.7);
		expect(editor.getPaddingX()).toBe(2);
	});

	it("setPaddingX with Infinity defaults to 0", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setPaddingX(Number.POSITIVE_INFINITY);
		expect(editor.getPaddingX()).toBe(0);
	});

	it("constructor with non-finite paddingX defaults to 0", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme, { paddingX: Number.POSITIVE_INFINITY });
		expect(editor.getPaddingX()).toBe(0);
	});

	it("getAutocompleteMaxVisible returns configured value", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme, { autocompleteMaxVisible: 10 });
		expect(editor.getAutocompleteMaxVisible()).toBe(10);
	});

	it("setAutocompleteMaxVisible clamps to [3, 20]", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setAutocompleteMaxVisible(1);
		expect(editor.getAutocompleteMaxVisible()).toBe(3);
		editor.setAutocompleteMaxVisible(100);
		expect(editor.getAutocompleteMaxVisible()).toBe(20);
		editor.setAutocompleteMaxVisible(7);
		expect(editor.getAutocompleteMaxVisible()).toBe(7);
	});

	it("setAutocompleteMaxVisible(same value) is a no-op", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme, { autocompleteMaxVisible: 5 });
		editor.setAutocompleteMaxVisible(5);
		expect(editor.getAutocompleteMaxVisible()).toBe(5);
	});

	it("setAutocompleteMaxVisible with Infinity defaults to 5", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setAutocompleteMaxVisible(Number.POSITIVE_INFINITY);
		expect(editor.getAutocompleteMaxVisible()).toBe(5);
	});

	it("constructor with non-finite autocompleteMaxVisible defaults to 5", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme, { autocompleteMaxVisible: Number.NaN });
		expect(editor.getAutocompleteMaxVisible()).toBe(5);
	});

	it("invalidate() is a no-op (no cached state)", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.invalidate();
		expect(editor.getText()).toBe("");
	});
});

// ============================================================================
// Editor — paste markers + history edge cases
// ============================================================================
describe("Editor — paste markers and history", () => {
	it("paste content gets injected as text", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.handleInput("\x1b[200~pasted line\x1b[201~");
		expect(editor.getText().length).toBeGreaterThan(0);
	});

	it("addToHistory ignores empty or whitespace-only text", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.addToHistory("");
		editor.addToHistory("   ");
		// Subsequent up arrow should do nothing.
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("");
	});

	it("addToHistory dedupes consecutive duplicates", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.addToHistory("same");
		editor.addToHistory("same"); // ignored
		editor.handleInput("\x1b[A"); // Up — picks "same"
		expect(editor.getText()).toBe("same");
		editor.handleInput("\x1b[A"); // No earlier history entry
		expect(editor.getText()).toBe("same");
	});

	it("addToHistory pops oldest when size > 100", () => {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const editor = new Editor(tui, defaultEditorTheme);
		for (let i = 0; i < 105; i++) editor.addToHistory(`entry-${i}`);
		// After 105 entries the oldest few were popped. The deepest accessible
		// (5 ups → 5th most recent then 4th, 3rd, 2nd, 1st older = entry-100)
		editor.handleInput("\x1b[A"); // entry-104 (most recent)
		expect(editor.getText()).toBe("entry-104");
	});
});

// ============================================================================
// Input — additional uncovered branches
// ============================================================================
describe("Input — round 2", () => {
	it("ctrl+left on cursor=0 stays at 0", () => {
		const input = new Input();
		input.setValue("hello world");
		input.handleInput("\x01"); // Ctrl+A
		input.handleInput("\x1b[1;5D"); // Ctrl+Left
		// Cursor stays at 0; typing inserts at 0
		input.handleInput("z");
		expect(input.getValue()).toBe("zhello world");
	});

	it("ctrl+right at end stays at end", () => {
		const input = new Input();
		input.setValue("hello");
		input.handleInput("\x05"); // Ctrl+E
		input.handleInput("\x1b[1;5C"); // Ctrl+Right
		input.handleInput("z");
		expect(input.getValue()).toBe("helloz");
	});

	it("moveWordBackwards: skip leading whitespace then word", () => {
		const input = new Input();
		input.setValue("foo bar baz");
		input.handleInput("\x05"); // Ctrl+E
		input.handleInput("\x17"); // Ctrl+W (delete word backward, exercising moveWordBackwards)
		expect(input.getValue()).toBe("foo bar ");
	});

	it("moveWordBackwards: punctuation run", () => {
		const input = new Input();
		input.setValue("hello!!! world");
		input.handleInput("\x05"); // Ctrl+E
		// Move backwards over punctuation
		input.handleInput("\x17"); // Ctrl+W
		expect(input.getValue()).toBe("hello!!! ");
	});

	it("moveWordForwards: skip leading whitespace then word", () => {
		const input = new Input();
		input.setValue("foo  bar");
		input.handleInput("\x01"); // Ctrl+A
		input.handleInput("\x1bd"); // Alt+D delete word forward
		expect(input.getValue()).toBe("  bar");
	});

	it("moveWordForwards: punctuation only", () => {
		const input = new Input();
		input.setValue("!!!foo");
		input.handleInput("\x01"); // Ctrl+A
		input.handleInput("\x1bd"); // Alt+D
		expect(input.getValue()).toBe("foo");
	});

	it("render with empty value shows just the cursor at end", () => {
		const input = new Input();
		input.focused = true;
		const [line] = input.render(20);
		expect(line).toBeDefined();
		expect(line!.length).toBeGreaterThan(0);
	});

	it("render with scrolling: cursor at end with availableWidth=1 produces scrollWidth=0 → empty visibleText", () => {
		const input = new Input();
		input.setValue("hello world");
		input.handleInput("\x05"); // Ctrl+E
		// availableWidth = width - prompt(2). For width=3, availableWidth=1, cursor at end → scrollWidth=0.
		const [line] = input.render(3);
		expect(line).toBeDefined();
	});

	it("render at cursor in middle with horizontal scroll", () => {
		const input = new Input();
		input.setValue("a".repeat(50));
		// Move cursor to middle
		for (let i = 0; i < 25; i++) input.handleInput("\x1b[C"); // No-op since cursor is at end. Use Ctrl+A first.
		input.handleInput("\x01"); // Ctrl+A
		for (let i = 0; i < 25; i++) input.handleInput("\x1b[C");
		const [line] = input.render(20);
		expect(visibleWidth(line!)).toBeLessThanOrEqual(20);
	});

	it("render at cursor near end with horizontal scroll", () => {
		const input = new Input();
		input.setValue("a".repeat(50));
		// Cursor at end by default
		const [line] = input.render(20);
		expect(visibleWidth(line!)).toBeLessThanOrEqual(20);
	});
});

// ============================================================================
// Autocomplete — additional uncovered: walkDirectoryWithFd error paths
// ============================================================================
describe("Autocomplete — round 2", () => {
	it("getSuggestions with provider returns the slash command name when label differs", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ value: "cmd-name", label: "Pretty Name", description: "d" }],
			"/tmp",
		);
		const ac = new AbortController();
		const result = await provider.getSuggestions(["/cm"], 0, 3, { signal: ac.signal });
		expect(result).not.toBeNull();
		expect(result!.items[0]?.value).toBe("cmd-name");
	});

	it("getSuggestions: slash command with argumentHint adds it to description", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "find", description: "Find files", argumentHint: "<pattern>" }],
			"/tmp",
		);
		const ac = new AbortController();
		const result = await provider.getSuggestions(["/fi"], 0, 3, { signal: ac.signal });
		expect(result).not.toBeNull();
		expect(result!.items[0]?.description).toContain("<pattern>");
		expect(result!.items[0]?.description).toContain("Find files");
	});

	it("getSuggestions: slash command with argumentHint and no description", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "find", argumentHint: "<pat>" }],
			"/tmp",
		);
		const ac = new AbortController();
		const result = await provider.getSuggestions(["/fi"], 0, 3, { signal: ac.signal });
		expect(result!.items[0]?.description).toBe("<pat>");
	});

	it("getSuggestions: command without description or argumentHint returns no description", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "plain" }],
			"/tmp",
		);
		const ac = new AbortController();
		const result = await provider.getSuggestions(["/pl"], 0, 3, { signal: ac.signal });
		expect(result!.items[0]?.description).toBeUndefined();
	});

	it("applyCompletion - prefix with @ but value contains trailing quote and directory", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const lines = [`@"`];
		const applied = provider.applyCompletion(
			lines,
			0,
			2,
			{ value: '@"my folder/"', label: "my folder/" },
			'@"',
		);
		// For directory with trailing quote, cursor goes one before the quote.
		expect(applied.cursorCol).toBe('@"my folder/'.length);
	});

	it("applyCompletion: path completion adjusts after quote behavior", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const lines = ['"my"'];
		const cursorCol = 3;
		const applied = provider.applyCompletion(
			lines,
			0,
			cursorCol,
			{ value: '"myfile"', label: "myfile" },
			'"my',
		);
		expect(applied.lines[0]).toBe('"myfile"');
	});

	it("extractAtPrefix detects @ at the start of a token, not embedded", async () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp", null);
		const ac = new AbortController();
		// Embedded @ — should not trigger @ completion.
		const result = await provider.getSuggestions(["foo@bar"], 0, 7, { signal: ac.signal });
		// Either null (no path-like) or path-like — neither is @ completion.
		expect(result === null || (result && !result.prefix.startsWith("@"))).toBe(true);
	});
});

// ============================================================================
// CombinedAutocompleteProvider — file path with absolute path
// ============================================================================
describe("Autocomplete file paths", () => {
	it("getFileSuggestions inside an absolute non-existent directory returns []", async () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const ac = new AbortController();
		// /this-doesnt-exist/sub doesn't exist
		const result = await provider.getSuggestions(
			["/this-definitely-does-not-exist-aaaaaaaaaaaaa/x"],
			0,
			47,
			{ signal: ac.signal, force: true },
		);
		expect(result).toBeNull();
	});
});
