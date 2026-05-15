// ADR-0017 phase C.7: cover the two simple registries in pi-web-ui.
import { describe, expect, it, vi } from "vitest";

// Mock external deps so tests don't need a full browser environment.
vi.mock("@mariozechner/mini-lit", () => ({
	icon: (..._args: unknown[]) => "<icon>",
	i18n: (s: string) => s,
}));

import { html, render } from "lit";
import { createRef } from "lit/directives/ref.js";
import {
	getMessageRenderer,
	registerMessageRenderer,
	renderMessage,
} from "../src/components/message-renderer-registry.js";
import {
	getToolRenderer,
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	toolRenderers,
} from "../src/tools/renderer-registry.js";

describe("message-renderer-registry", () => {
	it("registerMessageRenderer + getMessageRenderer round-trips a registered renderer", () => {
		const userRenderer = { render: () => "USER" as never };
		registerMessageRenderer("user", userRenderer as never);
		const found = getMessageRenderer("user");
		expect(found).toBe(userRenderer);
	});

	it("getMessageRenderer for an unregistered role returns undefined", () => {
		const found = getMessageRenderer("does-not-exist" as never);
		expect(found).toBeUndefined();
	});

	it("renderMessage delegates to the registered renderer for a known role", () => {
		const captured: unknown[] = [];
		registerMessageRenderer("assistant", {
			render: (msg) => {
				captured.push(msg);
				return "ASSISTANT_RENDERED" as never;
			},
		} as never);
		const result = renderMessage({ role: "assistant", content: [] } as never);
		expect(result).toBe("ASSISTANT_RENDERED");
		expect(captured).toHaveLength(1);
	});

	it("renderMessage returns undefined when no renderer is registered for the role", () => {
		const result = renderMessage({ role: "unmapped-role" } as never);
		expect(result).toBeUndefined();
	});
});

describe("renderer-registry (tool renderers)", () => {
	it("toolRenderers is the exported singleton Map", () => {
		expect(toolRenderers).toBeInstanceOf(Map);
	});

	it("registerToolRenderer + getToolRenderer round-trips a tool renderer", () => {
		const fakeRenderer = { renderInProgress: () => null, renderComplete: () => null, renderError: () => null };
		registerToolRenderer("Read", fakeRenderer as never);
		const found = getToolRenderer("Read");
		expect(found).toBe(fakeRenderer);
	});

	it("getToolRenderer for an unregistered tool returns undefined", () => {
		expect(getToolRenderer("NeverRegistered")).toBeUndefined();
	});

	it("a later registerToolRenderer replaces the prior renderer", () => {
		const first = { kind: "first" } as never;
		const second = { kind: "second" } as never;
		registerToolRenderer("Replace", first);
		registerToolRenderer("Replace", second);
		expect(getToolRenderer("Replace")).toBe(second);
	});
});

describe("renderHeader", () => {
	it.each(["inprogress", "complete", "error"] as const)(
		"renders a header for the '%s' state with the status icon and text",
		(state) => {
			const container = document.createElement("div");
			render(renderHeader(state, "tool-icon", "Doing a thing"), container);
			expect(container.textContent).toContain("Doing a thing");
			// inprogress shows an extra spinner icon on the right.
			const spans = container.querySelectorAll("span");
			expect(spans.length).toBe(state === "inprogress" ? 2 : 1);
		},
	);

	it("accepts a TemplateResult as the text argument", () => {
		const container = document.createElement("div");
		render(renderHeader("complete", "icon", html`<em>templated</em>`), container);
		expect(container.querySelector("em")?.textContent).toBe("templated");
	});
});

describe("renderCollapsibleHeader", () => {
	const mountHeader = (state: "inprogress" | "complete" | "error", defaultExpanded: boolean) => {
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();
		const content = document.createElement("div");
		content.classList.add(defaultExpanded ? "max-h-[2000px]" : "max-h-0");
		contentRef.value = content;
		const container = document.createElement("div");
		render(renderCollapsibleHeader(state, "tool-icon", "Header text", contentRef, chevronRef, defaultExpanded), container);
		const button = container.querySelector("button") as HTMLButtonElement;
		return { button, content, chevronRef, container };
	};

	it.each(["inprogress", "complete", "error"] as const)("renders a collapsible button for the '%s' state", (state) => {
		const { button, container } = mountHeader(state, false);
		expect(button).not.toBeNull();
		expect(container.textContent).toContain("Header text");
	});

	it("clicking expands collapsed content: removes max-h-0, adds max-h-[2000px] + mt-3", () => {
		const { button, content } = mountHeader("complete", false);
		button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(content.classList.contains("max-h-0")).toBe(false);
		expect(content.classList.contains("max-h-[2000px]")).toBe(true);
		expect(content.classList.contains("mt-3")).toBe(true);
	});

	it("clicking expanded content collapses it back: adds max-h-0, removes max-h-[2000px] + mt-3", () => {
		const { button, content } = mountHeader("complete", true);
		// defaultExpanded => content starts without max-h-0.
		button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(content.classList.contains("max-h-0")).toBe(true);
		expect(content.classList.contains("max-h-[2000px]")).toBe(false);
		expect(content.classList.contains("mt-3")).toBe(false);
	});

	it("toggling flips the chevron-up / chevrons-up-down hidden classes", () => {
		const { button, chevronRef } = mountHeader("complete", false);
		const chevron = chevronRef.value!;
		const up = chevron.querySelector(".chevron-up")!;
		const down = chevron.querySelector(".chevrons-up-down")!;
		// Collapsed initial state: up hidden, down visible.
		expect(up.classList.contains("hidden")).toBe(true);
		expect(down.classList.contains("hidden")).toBe(false);
		// Expand.
		button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(up.classList.contains("hidden")).toBe(false);
		expect(down.classList.contains("hidden")).toBe(true);
		// Collapse again.
		button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(up.classList.contains("hidden")).toBe(true);
		expect(down.classList.contains("hidden")).toBe(false);
	});

	it("click is a no-op when the content ref is unresolved (covers the `content && chevron` guard)", () => {
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();
		// contentRef.value left undefined.
		const container = document.createElement("div");
		render(renderCollapsibleHeader("inprogress", "icon", "T", contentRef, chevronRef, false), container);
		const button = container.querySelector("button") as HTMLButtonElement;
		expect(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).not.toThrow();
	});

	it("defaultExpanded=true renders the chevron-up visible initially", () => {
		const { chevronRef } = mountHeader("complete", true);
		const chevron = chevronRef.value!;
		expect(chevron.querySelector(".chevron-up")?.classList.contains("hidden")).toBe(false);
		expect(chevron.querySelector(".chevrons-up-down")?.classList.contains("hidden")).toBe(true);
	});
});
