// ADR-0017 phase B.4: cover Loader + CancellableLoader (both at 0% in
// the baseline). Uses fake timers for the spinner interval and a minimal
// stub TUI satisfying the `requestRender` contract Loader actually uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancellableLoader } from "../src/components/cancellable-loader.js";
import { Loader } from "../src/components/loader.js";
import type { TUI } from "../src/tui.js";

const stubTui = (): { tui: TUI; renderCount: { value: number } } => {
	const renderCount = { value: 0 };
	const tui = {
		requestRender: () => {
			renderCount.value++;
		},
	} as unknown as TUI;
	return { tui, renderCount };
};

const id = <T>(s: T): T => s;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Loader", () => {
	it("constructs with default message and requests a render on start", () => {
		const { tui, renderCount } = stubTui();
		const loader = new Loader(tui, id, id);
		// start() is called via setIndicator() in the constructor.
		expect(renderCount.value).toBeGreaterThan(0);
		loader.stop();
	});

	it("setMessage updates display and re-renders", () => {
		const { tui, renderCount } = stubTui();
		const loader = new Loader(tui, id, id, "Loading...");
		const initialRenders = renderCount.value;
		loader.setMessage("New message");
		expect(renderCount.value).toBeGreaterThan(initialRenders);
		loader.stop();
	});

	it("animation advances the frame on each interval tick", () => {
		const { tui, renderCount } = stubTui();
		const loader = new Loader(tui, id, id, "Working", { frames: ["a", "b", "c"], intervalMs: 50 });
		const start = renderCount.value;
		vi.advanceTimersByTime(50);
		vi.advanceTimersByTime(50);
		expect(renderCount.value).toBeGreaterThan(start);
		loader.stop();
	});

	it("setIndicator with a single-frame array does not start an interval (no animation)", () => {
		const { tui, renderCount } = stubTui();
		const loader = new Loader(tui, id, id, "Static", { frames: ["#"], intervalMs: 100 });
		const start = renderCount.value;
		vi.advanceTimersByTime(500);
		expect(renderCount.value).toBe(start); // no animation ticks
		loader.stop();
	});

	it("setIndicator with empty frames array uses empty indicator (covers frame.length === 0 branch)", () => {
		const { tui } = stubTui();
		const loader = new Loader(tui, id, id, "msg", { frames: [], intervalMs: 80 });
		// Render produces the loader output; the message should still be present.
		const result = loader.render(40);
		expect(result.length).toBeGreaterThan(0);
		loader.stop();
	});

	it("setIndicator with intervalMs <= 0 falls back to DEFAULT_INTERVAL_MS", () => {
		const { tui } = stubTui();
		const loader = new Loader(tui, id, id, "msg", { frames: ["a", "b"], intervalMs: 0 });
		// Internal — we just exercise the branch and confirm it doesn't crash.
		loader.stop();
	});

	it("stop() clears the interval; subsequent ticks do not advance frames", () => {
		const { tui, renderCount } = stubTui();
		const loader = new Loader(tui, id, id, "msg", { frames: ["a", "b", "c"], intervalMs: 50 });
		loader.stop();
		const start = renderCount.value;
		vi.advanceTimersByTime(500);
		expect(renderCount.value).toBe(start);
	});

	it("stop() when no interval is active is a no-op", () => {
		const { tui } = stubTui();
		const loader = new Loader(tui, id, id, "msg", { frames: ["only"], intervalMs: 50 });
		loader.stop(); // first stop
		loader.stop(); // second stop — covers the `if (this.intervalId)` false branch
	});

	it("renders with a leading empty line via the wrapping render() override", () => {
		const { tui } = stubTui();
		const loader = new Loader(tui, id, id, "msg");
		const lines = loader.render(40);
		expect(lines[0]).toBe("");
		loader.stop();
	});
});

describe("CancellableLoader", () => {
	it("constructs with signal not aborted", () => {
		const { tui } = stubTui();
		const loader = new CancellableLoader(tui, id, id, "msg");
		expect(loader.aborted).toBe(false);
		expect(loader.signal.aborted).toBe(false);
		loader.dispose();
	});

	it("handleInput on the cancel key aborts the signal and calls onAbort callback", () => {
		const { tui } = stubTui();
		const loader = new CancellableLoader(tui, id, id, "msg");
		let aborted = false;
		loader.onAbort = () => {
			aborted = true;
		};
		// "tui.select.cancel" default keybinding is Escape (\x1b) per TUI_KEYBINDINGS.
		loader.handleInput("\x1b");
		expect(loader.aborted).toBe(true);
		expect(loader.signal.aborted).toBe(true);
		expect(aborted).toBe(true);
		loader.dispose();
	});

	it("handleInput with a non-matching key is a no-op", () => {
		const { tui } = stubTui();
		const loader = new CancellableLoader(tui, id, id, "msg");
		loader.handleInput("a");
		expect(loader.aborted).toBe(false);
		loader.dispose();
	});

	it("handleInput with cancel key when onAbort is undefined still aborts the signal", () => {
		const { tui } = stubTui();
		const loader = new CancellableLoader(tui, id, id, "msg");
		// No onAbort assigned — covers `this.onAbort?.()` undefined branch.
		loader.handleInput("\x1b");
		expect(loader.aborted).toBe(true);
		loader.dispose();
	});

	it("dispose() stops the animation interval", () => {
		const { tui, renderCount } = stubTui();
		const loader = new CancellableLoader(tui, id, id, "msg", { frames: ["a", "b"], intervalMs: 50 });
		loader.dispose();
		const start = renderCount.value;
		vi.advanceTimersByTime(500);
		expect(renderCount.value).toBe(start);
	});
});
