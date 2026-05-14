// ADR-0017 phase C.7: MarkdownArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

const { CopyButtonStub, PreviewCodeToggleStub } = vi.hoisted(() => {
	class CopyButtonStubInner extends HTMLElement {
		text = "";
		title = "";
		showText = true;
	}
	class PreviewCodeToggleStubInner extends HTMLElement {
		mode: "preview" | "code" = "preview";
	}
	if (!customElements.get("md-copy-stub")) customElements.define("md-copy-stub", CopyButtonStubInner);
	if (!customElements.get("md-toggle-stub")) customElements.define("md-toggle-stub", PreviewCodeToggleStubInner);
	return { CopyButtonStub: CopyButtonStubInner, PreviewCodeToggleStub: PreviewCodeToggleStubInner };
});

vi.mock("@mariozechner/mini-lit/dist/CopyButton.js", () => ({ CopyButton: CopyButtonStub }));
vi.mock("@mariozechner/mini-lit/dist/PreviewCodeToggle.js", () => ({ PreviewCodeToggle: PreviewCodeToggleStub }));
vi.mock("@mariozechner/mini-lit/dist/MarkdownBlock.js", () => ({}));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: () => document.createElement("button"),
}));
vi.mock("highlight.js", () => ({ default: { highlight: () => ({ value: "h" }) } }));

import "../src/tools/artifacts/MarkdownArtifact.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (filename: string, content: string): Promise<HTMLElement> => {
	const el = document.createElement("markdown-artifact") as HTMLElement & {
		filename: string;
		content: string;
		updateComplete?: Promise<unknown>;
		getHeaderButtons: () => unknown;
	};
	el.filename = filename;
	el.content = content;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

describe("MarkdownArtifact", () => {
	it("preview mode renders <markdown-block> with content (default mode)", async () => {
		const el = await make("notes.md", "# Hello");
		expect(el.querySelector("markdown-block")).not.toBeNull();
	});

	it("setting content via setter updates the rendered output", async () => {
		const el = (await make("a.md", "old")) as HTMLElement & {
			content: string;
			updateComplete?: Promise<unknown>;
		};
		el.content = "new";
		await el.updateComplete;
		expect(el.querySelector("markdown-block")).not.toBeNull();
	});

	it("getHeaderButtons returns a TemplateResult with toggle + copy + download", async () => {
		const el = (await make("a.md", "x")) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		expect(container.querySelector("md-toggle-stub")).not.toBeNull();
		expect(container.querySelector("md-copy-stub")).not.toBeNull();
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("PreviewCodeToggle mode-change event flips to code view (covers setViewMode + code branch)", async () => {
		const el = (await make("a.md", "# heading")) as HTMLElement & {
			getHeaderButtons: () => unknown;
			updateComplete?: Promise<unknown>;
		};
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		const toggle = container.querySelector("md-toggle-stub") as HTMLElement;
		toggle.dispatchEvent(new CustomEvent("mode-change", { detail: "code" }));
		await el.updateComplete;
		// In code mode, the <pre> with hljs renders.
		expect(el.querySelector("pre code.language-markdown")).not.toBeNull();
		// Flip back.
		toggle.dispatchEvent(new CustomEvent("mode-change", { detail: "preview" }));
		await el.updateComplete;
		expect(el.querySelector("markdown-block")).not.toBeNull();
	});

	it("createRenderRoot returns this (light DOM)", async () => {
		const el = (await make("a.md", "x")) as HTMLElement & {
			createRenderRoot: () => HTMLElement;
		};
		// Class method is protected; we test via the rendered DOM being directly on the element.
		expect(el.querySelector("markdown-block")).not.toBeNull();
	});

	it("content getter returns the stored value", async () => {
		const el = (await make("a.md", "abc")) as HTMLElement & { content: string };
		expect(el.content).toBe("abc");
	});
});
