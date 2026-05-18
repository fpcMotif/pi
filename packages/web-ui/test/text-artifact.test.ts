// ADR-0017 phase C.7: TextArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

const { CopyButtonStub } = vi.hoisted(() => {
	class CopyButtonStubInner extends HTMLElement {
		text = "";
		title = "";
		showText = true;
	}
	if (!customElements.get("copy-button-stub-text"))
		customElements.define("copy-button-stub-text", CopyButtonStubInner);
	return { CopyButtonStub: CopyButtonStubInner };
});

vi.mock("@mariozechner/mini-lit/dist/CopyButton.js", () => ({ CopyButton: CopyButtonStub }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: (opts: { filename: string; mimeType: string }) => {
		const el = document.createElement("button");
		el.dataset.filename = opts.filename;
		el.dataset.mime = opts.mimeType;
		return el;
	},
}));
vi.mock("highlight.js", () => ({ default: { highlight: (code: string) => ({ value: code }) } }));

import "../src/tools/artifacts/TextArtifact.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (filename: string, content: string): Promise<HTMLElement> => {
	const el = document.createElement("text-artifact") as HTMLElement & {
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

describe("TextArtifact", () => {
	it("renders plain <pre> for non-code text files", async () => {
		const el = await make("note.txt", "hello world");
		const pre = el.querySelector("pre");
		expect(pre).not.toBeNull();
		expect(pre!.querySelector("code.language-txt")).toBeNull();
		expect(pre!.textContent).toContain("hello world");
	});

	it("renders highlighted <code> with language class for known code extensions", async () => {
		const el = await make("script.js", "const x = 1");
		expect(el.querySelector("code.language-javascript")).not.toBeNull();
	});

	it.each([
		["ts", "typescript"],
		["py", "python"],
		["rb", "ruby"],
		["yml", "yaml"],
		["ps1", "powershell"],
		["bat", "batch"],
	])("language map: '%s' → '%s'", async (ext, lang) => {
		const el = await make(`f.${ext}`, "code");
		expect(el.querySelector(`code.language-${lang}`)).not.toBeNull();
	});

	it("language map fallback: known code extension WITHOUT mapping uses ext as-is (covers || ext)", async () => {
		const el = await make("f.rust", "fn main() {}");
		expect(el.querySelector("code.language-rust")).not.toBeNull();
	});

	it.each([
		["a.svg", "image/svg+xml"],
		["doc.md", "text/markdown"],
		["doc.markdown", "text/markdown"],
		["note.txt", "text/plain"],
		["no-extension", "text/plain"],
	])("getMimeType: '%s' → %s", async (filename, expectedMime) => {
		const el = (await make(filename, "x")) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		const btn = container.querySelector("button") as HTMLButtonElement;
		expect(btn.dataset.mime).toBe(expectedMime);
	});

	it("isCode returns false for non-code filenames (covers filename without extension)", async () => {
		const el = await make("README", "no ext");
		// Non-code path renders plain <pre> without language class.
		expect(el.querySelector("code")).toBeNull();
	});

	it("setting content updates the rendered text (content setter triggers requestUpdate)", async () => {
		const el = (await make("a.txt", "initial")) as HTMLElement & {
			content: string;
			updateComplete?: Promise<unknown>;
		};
		expect(el.querySelector("pre")?.textContent).toContain("initial");
		el.content = "updated";
		await el.updateComplete;
		expect(el.querySelector("pre")?.textContent).toContain("updated");
	});

	it("getHeaderButtons populates CopyButton text with current content", async () => {
		const el = (await make("a.txt", "copy this")) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		const copyBtn = container.querySelector("copy-button-stub-text") as HTMLElement & { text?: string };
		expect(copyBtn.text).toBe("copy this");
	});

	it("filename with no dot still renders fine (covers ?.toLowerCase() || '' empty branches)", async () => {
		const el = await make("plain", "x");
		expect(el.querySelector("pre")).not.toBeNull();
	});

	it('filename ending in a dot yields an empty extension (covers the `|| ""` fallback in isCode/getMimeType/render)', async () => {
		// "a.".split(".") === ["a", ""], so pop() === "" — a falsy left operand
		// of `|| ""` in isCode(), getMimeType(), and render().
		const el = (await make("trailingdot.", "body")) as HTMLElement & { getHeaderButtons: () => unknown };
		// Empty ext is not a code extension → plain <pre>, no language class.
		expect(el.querySelector("code")).toBeNull();
		expect(el.querySelector("pre")?.textContent).toContain("body");
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		const btn = container.querySelector("button") as HTMLButtonElement;
		expect(btn.dataset.mime).toBe("text/plain");
	});
});
