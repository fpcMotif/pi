// ADR-0017 phase C.7: tools/artifacts/Console Lit component (artifact-console).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>", i18n: (s: string) => s }));
vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit/dist/CopyButton.js", () => ({
	CopyButton: class extends HTMLElement {},
}));

import "../src/tools/artifacts/Console.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (logs: Array<{ type: "log" | "error"; text: string }>): Promise<HTMLElement> => {
	const el = document.createElement("artifact-console") as HTMLElement & {
		logs: typeof logs;
		updateComplete?: Promise<unknown>;
	};
	el.logs = logs;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("artifact-console", () => {
	it("collapsed by default — only the summary button is rendered", async () => {
		const el = await make([{ type: "log", text: "hi" }]);
		// Summary buttons + autoscroll + copy + logs container only show when expanded.
		const buttons = el.querySelectorAll("button");
		expect(buttons.length).toBe(1);
	});

	it("with zero errors shows '<n>' counter in the summary", async () => {
		const el = await make([
			{ type: "log", text: "a" },
			{ type: "log", text: "b" },
		]);
		expect(el.textContent).toContain("(2)");
	});

	it("with single error uses singular 'error' label", async () => {
		const el = await make([
			{ type: "error", text: "boom" },
			{ type: "log", text: "x" },
		]);
		expect(el.textContent).toContain("1 error");
		expect(el.textContent).not.toContain("errors");
	});

	it("with multiple errors uses plural 'errors' label", async () => {
		const el = await make([
			{ type: "error", text: "a" },
			{ type: "error", text: "b" },
		]);
		expect(el.textContent).toContain("2 errors");
	});

	it("clicking the summary button expands and shows logs + autoscroll + copy controls", async () => {
		const el = (await make([{ type: "log", text: "abc" }])) as HTMLElement & {
			updateComplete?: Promise<unknown>;
		};
		const btn = el.querySelector("button") as HTMLButtonElement;
		btn.click();
		await el.updateComplete;
		expect(el.textContent).toContain("[log] abc");
		const buttons = el.querySelectorAll("button");
		expect(buttons.length).toBeGreaterThanOrEqual(2);
	});

	it("autoscroll toggle flips state and updates the icon title", async () => {
		const el = (await make([{ type: "log", text: "x" }])) as HTMLElement & {
			updateComplete?: Promise<unknown>;
		};
		(el.querySelector("button") as HTMLButtonElement).click();
		await el.updateComplete;
		// Find the autoscroll toggle button (second button).
		const autoscrollBtn = el.querySelectorAll("button")[1] as HTMLButtonElement;
		expect(autoscrollBtn.title).toContain("enabled");
		autoscrollBtn.click();
		await el.updateComplete;
		const updated = el.querySelectorAll("button")[1] as HTMLButtonElement;
		expect(updated.title).toContain("disabled");
	});

	it("expanded view renders each log line with the correct type prefix", async () => {
		const el = (await make([
			{ type: "log", text: "info-line" },
			{ type: "error", text: "bad-line" },
		])) as HTMLElement & { updateComplete?: Promise<unknown> };
		(el.querySelector("button") as HTMLButtonElement).click();
		await el.updateComplete;
		expect(el.textContent).toContain("[log] info-line");
		expect(el.textContent).toContain("[error] bad-line");
	});

	it("collapsing again hides the log lines", async () => {
		const el = (await make([{ type: "log", text: "xx" }])) as HTMLElement & {
			updateComplete?: Promise<unknown>;
		};
		const btn = el.querySelector("button") as HTMLButtonElement;
		btn.click();
		await el.updateComplete;
		expect(el.textContent).toContain("[log] xx");
		btn.click();
		await el.updateComplete;
		expect(el.textContent).not.toContain("[log] xx");
	});

	it("autoscroll scrolls logs container to bottom on update when autoscroll+expanded (covers updated())", async () => {
		const el = (await make([{ type: "log", text: "first" }])) as HTMLElement & {
			updateComplete?: Promise<unknown>;
			logs: Array<{ type: "log" | "error"; text: string }>;
		};
		(el.querySelector("button") as HTMLButtonElement).click();
		await el.updateComplete;
		// Force a scrollHeight via defineProperty so we can verify scrollTop assignment.
		const container = el.querySelector(".max-h-48") as HTMLElement;
		Object.defineProperty(container, "scrollHeight", { value: 999, configurable: true });
		// Trigger a re-render via a logs update.
		el.logs = [...el.logs, { type: "log", text: "second" }];
		await el.updateComplete;
		expect(container.scrollTop).toBe(999);
	});
});
