// ADR-0017 coverage push: DocxArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: () => document.createElement("button"),
}));

const { renderAsyncMock } = vi.hoisted(() => ({ renderAsyncMock: vi.fn() }));
vi.mock("docx-preview", () => ({
	renderAsync: (...args: unknown[]) => renderAsyncMock(...args),
}));

import "../src/tools/artifacts/DocxArtifact.js";

afterEach(() => {
	document.body.innerHTML = "";
	renderAsyncMock.mockReset();
});

const make = async (filename: string, content: string) => {
	const el = document.createElement("docx-artifact") as HTMLElement & {
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

describe("DocxArtifact", () => {
	it("renders a container div for the docx preview", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const el = await make("doc.docx", btoa("HELLO"));
		expect(el.querySelector("#docx-container")).not.toBeNull();
	});

	it("content getter returns the stored base64 content", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const el = await make("a.docx", btoa("X"));
		expect((el as HTMLElement & { content: string }).content).toBe(btoa("X"));
	});

	it("setting content via the setter clears prior error and re-renders", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const el = (await make("a.docx", btoa("Y"))) as HTMLElement & {
			content: string;
			updateComplete?: Promise<unknown>;
			error: string | null;
		};
		el.error = "old failure";
		renderAsyncMock.mockResolvedValueOnce(undefined);
		el.content = btoa("Z");
		await el.updateComplete;
		expect(el.error).toBeNull();
	});

	it("invokes docx-preview.renderAsync with the decoded ArrayBuffer (covers renderDocx success path)", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		await make("doc.docx", btoa("HELLO"));
		expect(renderAsyncMock).toHaveBeenCalledOnce();
		const [buf, wrapper] = renderAsyncMock.mock.calls[0];
		expect(buf).toBeInstanceOf(ArrayBuffer);
		expect((wrapper as HTMLElement).className).toBe("docx-wrapper-custom");
	});

	it("renderDocx error path stores error message and re-renders error UI", async () => {
		renderAsyncMock.mockRejectedValueOnce(new Error("boom"));
		const el = (await make("doc.docx", btoa("HELLO"))) as HTMLElement & {
			error: string | null;
			updateComplete?: Promise<unknown>;
		};
		await el.updateComplete;
		expect(el.error).toBe("boom");
		expect(el.querySelector(".bg-destructive\\/10")?.textContent).toContain("boom");
	});

	it("renderDocx error path falls back to default message when error has no .message", async () => {
		renderAsyncMock.mockRejectedValueOnce({});
		const el = (await make("doc.docx", btoa("HI"))) as HTMLElement & {
			error: string | null;
			updateComplete?: Promise<unknown>;
		};
		await el.updateComplete;
		expect(el.error).toBe("Failed to load document");
	});

	it("decodes base64 content with a `data:...;base64,` URL prefix in base64ToArrayBuffer", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const dataUrl = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${btoa("DATA")}`;
		await make("d.docx", dataUrl);
		const [buf] = renderAsyncMock.mock.calls[0];
		expect(new TextDecoder().decode(new Uint8Array(buf as ArrayBuffer))).toBe("DATA");
	});

	it("getHeaderButtons returns a TemplateResult with a download button (covers decodeBase64 path)", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const el = (await make("a.docx", btoa("X"))) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("getHeaderButtons strips a data: prefix when decoding (covers decodeBase64 data: branch)", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const dataUrl = `data:foo;base64,${btoa("ABC")}`;
		const el = (await make("a.docx", dataUrl)) as HTMLElement & { getHeaderButtons: () => unknown };
		expect(() => el.getHeaderButtons()).not.toThrow();
	});

	it("updated is a no-op when container is missing (covers early return)", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const el = (await make("a.docx", btoa("X"))) as HTMLElement & {
			updated: (m: Map<string, unknown>) => Promise<void>;
		};
		// Strip the container before invoking updated again.
		el.innerHTML = "";
		await el.updated(new Map([["_content", btoa("Y")]]));
		// No error thrown; renderAsync count unchanged (still 1 from initial render).
		expect(renderAsyncMock).toHaveBeenCalledOnce();
	});

	it("updated skips renderDocx when there's a prior error (covers !this.error guard)", async () => {
		renderAsyncMock.mockRejectedValueOnce(new Error("first failure"));
		const el = (await make("a.docx", btoa("X"))) as HTMLElement & {
			error: string | null;
			updateComplete?: Promise<unknown>;
			updated: (m: Map<string, unknown>) => Promise<void>;
		};
		await el.updateComplete;
		expect(el.error).toBe("first failure");
		// Trigger an updated cycle without resetting the error — should NOT call renderAsync again.
		await el.updated(new Map([["_content", btoa("X")]]));
		expect(renderAsyncMock).toHaveBeenCalledOnce();
	});

	it("connectedCallback sets display:block and height:100% on the element", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const el = await make("a.docx", btoa("X"));
		expect(el.style.display).toBe("block");
		expect(el.style.height).toBe("100%");
	});

	it("createRenderRoot returns this (light DOM) so #docx-container lives directly under the element", async () => {
		renderAsyncMock.mockResolvedValueOnce(undefined);
		const el = await make("a.docx", btoa("X"));
		// Light DOM means querySelector reaches the container directly.
		expect(el.querySelector("#docx-container")).not.toBeNull();
		expect(el.shadowRoot).toBeNull();
	});
});
