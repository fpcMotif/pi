// ADR-0017 phase C.7: ConsoleBlock Lit component with clipboard + auto-scroll.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>" }));
vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

// Stub navigator.clipboard so copy() can succeed.
const writeTextMock = vi.fn(async () => {});
Object.defineProperty(globalThis, "navigator", {
	value: { clipboard: { writeText: writeTextMock } },
	configurable: true,
});

import "../src/components/ConsoleBlock.js";

afterEach(() => {
	document.body.innerHTML = "";
	writeTextMock.mockClear();
});

const make = async (content: string, variant: "default" | "error" = "default"): Promise<HTMLElement> => {
	const el = document.createElement("console-block") as HTMLElement & {
		content: string;
		variant: "default" | "error";
		updateComplete?: Promise<unknown>;
	};
	el.content = content;
	el.variant = variant;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("ConsoleBlock", () => {
	it("renders the content and the 'console' label", async () => {
		const el = await make("line one\nline two");
		expect(el.textContent).toContain("line one");
		expect(el.textContent).toContain("line two");
		expect(el.textContent).toContain("console");
	});

	it("sets style.display = 'block' on connectedCallback", async () => {
		const el = await make("x");
		expect(el.style.display).toBe("block");
	});

	it("applies error styling when variant='error'", async () => {
		const el = await make("oh no", "error");
		// The pre tag carries the destructive class.
		const pre = el.querySelector("pre");
		expect(pre?.className).toContain("text-destructive");
	});

	it("applies default styling when variant='default'", async () => {
		const el = await make("ok", "default");
		const pre = el.querySelector("pre");
		expect(pre?.className).toContain("text-foreground");
	});

	it("clicking the copy button writes content to clipboard and toggles the copied state", async () => {
		const el = (await make("hello")) as HTMLElement & { updateComplete?: Promise<unknown> };
		const btn = el.querySelector("button");
		expect(btn).not.toBeNull();
		btn!.click();
		// Wait microtask for the async copy() to flush.
		await new Promise((r) => setTimeout(r, 0));
		await el.updateComplete;
		expect(writeTextMock).toHaveBeenCalledWith("hello");
		// After copy, "Copied!" indicator appears in the button.
		expect(el.textContent).toContain("Copied!");
	});

	it("falls back to '' when content is empty (covers || '' branch)", async () => {
		const el = await make("");
		// Click triggers writeText with "".
		const btn = el.querySelector("button");
		btn!.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(writeTextMock).toHaveBeenCalledWith("");
	});

	it("catches clipboard write errors without throwing (covers try/catch)", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		writeTextMock.mockImplementationOnce(async () => {
			throw new Error("clipboard denied");
		});
		const el = await make("any");
		el.querySelector("button")!.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("updated() scrolls the console-scroll container to the bottom", async () => {
		const el = (await make("first")) as HTMLElement & { content: string; updateComplete?: Promise<unknown> };
		const scroll = el.querySelector(".console-scroll") as HTMLElement;
		expect(scroll).not.toBeNull();
		// Set scrollHeight via a manual setter so the auto-scroll has something to target.
		Object.defineProperty(scroll, "scrollHeight", { value: 123, configurable: true });
		el.content = "second";
		await el.updateComplete;
		expect(scroll.scrollTop).toBe(123);
	});

	it("copied state resets to false after the 1500ms setTimeout (covers line 27)", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		try {
			const el = (await make("z")) as HTMLElement & { updateComplete?: Promise<unknown> };
			el.querySelector("button")!.click();
			// Drain microtasks so the async writeText resolves and `copied = true` applies.
			await vi.advanceTimersByTimeAsync(0);
			await el.updateComplete;
			expect(el.textContent).toContain("Copied!");
			// Advance past 1500ms; the setTimeout flips copied back to false.
			await vi.advanceTimersByTimeAsync(1500);
			await el.updateComplete;
			expect(el.textContent).not.toContain("Copied!");
		} finally {
			vi.useRealTimers();
		}
	});
});
