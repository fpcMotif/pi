// ADR-0017 phase C.7: ThinkingBlock Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>" }));

import "../src/components/ThinkingBlock.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (content: string, isStreaming = false): Promise<HTMLElement> => {
	const el = document.createElement("thinking-block") as HTMLElement & {
		content: string;
		isStreaming: boolean;
		updateComplete?: Promise<unknown>;
	};
	el.content = content;
	el.isStreaming = isStreaming;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("ThinkingBlock", () => {
	it("renders 'Thinking...' header collapsed by default", async () => {
		const el = await make("internal thoughts");
		expect(el.textContent).toContain("Thinking...");
		// Collapsed: no markdown-block child rendered.
		expect(el.querySelector("markdown-block")).toBeNull();
	});

	it("connectedCallback sets style.display='block'", async () => {
		const el = await make("x");
		expect(el.style.display).toBe("block");
	});

	it("clicking the header toggles expanded; markdown-block appears with content", async () => {
		const el = (await make("hidden text")) as HTMLElement & { updateComplete?: Promise<unknown> };
		const header = el.querySelector(".thinking-header") as HTMLElement;
		header.click();
		await el.updateComplete;
		expect(el.querySelector("markdown-block")).not.toBeNull();
		header.click();
		await el.updateComplete;
		expect(el.querySelector("markdown-block")).toBeNull();
	});

	it("when isStreaming=true the header applies the shimmer class on 'Thinking...' span", async () => {
		const el = await make("streaming", true);
		const text = el.querySelector(".thinking-header span:last-of-type") as HTMLElement;
		expect(text.className).toContain("animate-shimmer");
	});

	it("when isStreaming=false the shimmer class is absent", async () => {
		const el = await make("static", false);
		const text = el.querySelector(".thinking-header span:last-of-type") as HTMLElement;
		expect(text.className).not.toContain("animate-shimmer");
	});

	it("expanded chevron has rotate-90 class; collapsed has no rotation", async () => {
		const el = (await make("c")) as HTMLElement & { updateComplete?: Promise<unknown> };
		const chevronSpan = el.querySelector(".thinking-header span") as HTMLElement;
		expect(chevronSpan.className).not.toContain("rotate-90");
		(el.querySelector(".thinking-header") as HTMLElement).click();
		await el.updateComplete;
		const chevronSpan2 = el.querySelector(".thinking-header span") as HTMLElement;
		expect(chevronSpan2.className).toContain("rotate-90");
	});
});
