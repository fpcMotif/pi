// ADR-0017 phase C.7: ExpandableSection Lit component (light-DOM).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ icon: () => "<icon/>" }));

import "../src/components/ExpandableSection.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (summary: string, defaultExpanded = false, children: string[] = []): Promise<HTMLElement> => {
	const el = document.createElement("expandable-section") as HTMLElement & {
		summary: string;
		defaultExpanded: boolean;
		updateComplete?: Promise<unknown>;
	};
	el.summary = summary;
	el.defaultExpanded = defaultExpanded;
	for (const c of children) {
		const child = document.createElement("span");
		child.textContent = c;
		el.appendChild(child);
	}
	document.body.appendChild(el);
	// Let Lit settle.
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("ExpandableSection", () => {
	it("connectedCallback captures children and clears the innerHTML", async () => {
		const el = await make("My section", false, ["alpha", "beta"]);
		// After connectedCallback, the original children are removed from DOM
		// (they're stashed in `capturedChildren`). The button always renders;
		// children are only re-attached when expanded.
		const buttons = el.querySelectorAll("button");
		expect(buttons.length).toBe(1);
		expect(el.textContent).toContain("My section");
		// Children NOT visible while collapsed.
		expect(el.textContent).not.toContain("alpha");
	});

	it("defaultExpanded=true renders captured children inside the body", async () => {
		const el = await make("Open by default", true, ["one", "two"]);
		expect(el.textContent).toContain("one");
		expect(el.textContent).toContain("two");
	});

	it("clicking the toggle button flips expanded state and re-renders children", async () => {
		const el = await make("Toggle me", false, ["hidden-at-first"]);
		expect(el.textContent).not.toContain("hidden-at-first");

		const btn = el.querySelector("button");
		expect(btn).not.toBeNull();
		btn!.click();
		await (el as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		expect(el.textContent).toContain("hidden-at-first");

		btn!.click();
		await (el as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
		expect(el.textContent).not.toContain("hidden-at-first");
	});

	it("works with no children (empty captured list)", async () => {
		const el = await make("empty", true, []);
		expect(el.textContent).toContain("empty");
		// No additional inner content beyond summary + chevron icon.
	});
});
