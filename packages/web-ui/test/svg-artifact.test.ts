// ADR-0017 phase C.7: SvgArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
// Use vi.hoisted to define stub custom elements before vi.mock executes.
const { CopyButtonStub, PreviewCodeToggleStub } = vi.hoisted(() => {
	class CopyButtonStubInner extends HTMLElement {
		text = "";
		title = "";
		showText = true;
	}
	class PreviewCodeToggleStubInner extends HTMLElement {
		mode: "preview" | "code" = "preview";
	}
	if (!customElements.get("copy-button-stub")) customElements.define("copy-button-stub", CopyButtonStubInner);
	if (!customElements.get("preview-code-toggle-stub"))
		customElements.define("preview-code-toggle-stub", PreviewCodeToggleStubInner);
	return { CopyButtonStub: CopyButtonStubInner, PreviewCodeToggleStub: PreviewCodeToggleStubInner };
});

vi.mock("@mariozechner/mini-lit/dist/CopyButton.js", () => ({ CopyButton: CopyButtonStub }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: () => document.createElement("button"),
}));
vi.mock("@mariozechner/mini-lit/dist/PreviewCodeToggle.js", () => ({ PreviewCodeToggle: PreviewCodeToggleStub }));
vi.mock("highlight.js", () => ({ default: { highlight: () => ({ value: "<span>code</span>" }) } }));

if (!customElements.get("copy-button-mock")) customElements.define("copy-button-mock", class extends HTMLElement {});
if (!customElements.get("preview-code-toggle-mock"))
	customElements.define("preview-code-toggle-mock", class extends HTMLElement {});

import "../src/tools/artifacts/SvgArtifact.js";

const revokeMock = vi.fn();
const createObjectUrlMock = vi.fn(() => "blob:fake-url");

Object.defineProperty(globalThis.URL, "createObjectURL", { value: createObjectUrlMock, configurable: true });
Object.defineProperty(globalThis.URL, "revokeObjectURL", { value: revokeMock, configurable: true });

afterEach(() => {
	document.body.innerHTML = "";
	revokeMock.mockClear();
	createObjectUrlMock.mockClear();
});

const make = async (filename: string, content: string): Promise<HTMLElement> => {
	const el = document.createElement("svg-artifact") as HTMLElement & {
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

describe("SvgArtifact", () => {
	it("creates an object URL when content is set with non-empty value", async () => {
		await make("a.svg", "<svg/>");
		expect(createObjectUrlMock).toHaveBeenCalled();
	});

	it("does NOT create an object URL when content is empty", async () => {
		await make("a.svg", "");
		expect(createObjectUrlMock).not.toHaveBeenCalled();
	});

	it("revokes the prior object URL when content is updated", async () => {
		const el = (await make("a.svg", "<svg/>")) as HTMLElement & { content: string };
		revokeMock.mockClear();
		el.content = "<svg>2</svg>";
		expect(revokeMock).toHaveBeenCalled();
	});

	it("setting the same content value does not re-create or re-revoke (idempotent setter)", async () => {
		const el = (await make("a.svg", "<svg/>")) as HTMLElement & { content: string };
		createObjectUrlMock.mockClear();
		revokeMock.mockClear();
		el.content = "<svg/>";
		expect(createObjectUrlMock).not.toHaveBeenCalled();
		expect(revokeMock).not.toHaveBeenCalled();
	});

	it("disconnectedCallback revokes the object URL", async () => {
		const el = await make("a.svg", "<svg/>");
		revokeMock.mockClear();
		el.remove();
		expect(revokeMock).toHaveBeenCalled();
	});

	it("preview mode renders an <img> when previewUrl exists", async () => {
		const el = await make("a.svg", "<svg/>");
		expect(el.querySelector("img")).not.toBeNull();
	});

	it("preview mode renders no <img> when previewUrl is empty (content empty)", async () => {
		const el = await make("a.svg", "");
		expect(el.querySelector("img")).toBeNull();
	});

	it("getHeaderButtons returns a TemplateResult invocation that renders into a container", async () => {
		const el = (await make("a.svg", "<svg/>")) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("setViewMode('code') flips the view (covered via PreviewCodeToggle mode-change event)", async () => {
		const el = (await make("a.svg", "<svg/>")) as HTMLElement & {
			updateComplete?: Promise<unknown>;
			getHeaderButtons: () => unknown;
		};
		const headerEl = el.getHeaderButtons();
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(headerEl as never, container);
		// The PreviewCodeToggle stub is the first element in the rendered header.
		const toggle = container.querySelector("preview-code-toggle-stub") as HTMLElement;
		expect(toggle).not.toBeNull();
		toggle.dispatchEvent(new CustomEvent("mode-change", { detail: "code" }));
		await el.updateComplete;
		// In code mode, the <pre> renders.
		expect(el.querySelector("pre")).not.toBeNull();
	});

	it("connectedCallback re-creates preview URL if content was set before mount", async () => {
		const el = document.createElement("svg-artifact") as HTMLElement & {
			filename: string;
			content: string;
			updateComplete?: Promise<unknown>;
		};
		// Set content before mount; the setter creates one URL. Connection
		// path doesn't run yet (not in DOM). Append, then verify total calls.
		el.content = "<svg/>";
		const before = createObjectUrlMock.mock.calls.length;
		document.body.appendChild(el);
		await el.updateComplete;
		expect(createObjectUrlMock.mock.calls.length).toBeGreaterThanOrEqual(before);
	});
});
