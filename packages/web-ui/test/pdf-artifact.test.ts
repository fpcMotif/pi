// ADR-0017 coverage push: PdfArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: () => document.createElement("button"),
}));

const { pdfState } = vi.hoisted(() => ({
	pdfState: {
		nextDocResult: undefined as
			| { kind: "pages"; pages: Array<{ render?: (opts: unknown) => { promise: Promise<void> } }> }
			| { kind: "fail"; error: unknown }
			| undefined,
		destroyedLoadingTask: false,
		destroyedDoc: false,
	},
}));

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	getDocument: () => {
		const state = pdfState.nextDocResult;
		const loadingTask = {
			destroy: () => {
				pdfState.destroyedLoadingTask = true;
			},
			promise: (async () => {
				if (!state) throw new Error("no canned doc");
				if (state.kind === "fail") throw state.error;
				return {
					numPages: state.pages.length,
					getPage: async (n: number) => {
						const page = state.pages[n - 1];
						return {
							getViewport: () => ({ width: 100, height: 100 }),
							render: page.render ? page.render : () => ({ promise: Promise.resolve() }),
						};
					},
					destroy: () => {
						pdfState.destroyedDoc = true;
					},
				};
			})(),
		};
		return loadingTask;
	},
}));

import "../src/tools/artifacts/PdfArtifact.js";

afterEach(() => {
	document.body.innerHTML = "";
	pdfState.nextDocResult = undefined;
	pdfState.destroyedLoadingTask = false;
	pdfState.destroyedDoc = false;
});

const make = async (filename: string, content: string) => {
	const el = document.createElement("pdf-artifact") as HTMLElement & {
		filename: string;
		content: string;
		updateComplete?: Promise<unknown>;
		getHeaderButtons: () => unknown;
		error: string | null;
		currentLoadingTask: { destroy: () => void } | null;
	};
	el.filename = filename;
	el.content = content;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	// Wait for the async renderPdf to fire.
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
	return el;
};

describe("PdfArtifact", () => {
	it("renders the pdf-container outer element", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = await make("a.pdf", btoa("X"));
		expect(el.querySelector("#pdf-container")).not.toBeNull();
	});

	it("content getter/setter clears prior error and triggers a re-render", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = (await make("a.pdf", btoa("X"))) as HTMLElement & {
			error: string | null;
			content: string;
			updateComplete?: Promise<unknown>;
		};
		expect(el.content).toBe(btoa("X"));
		el.error = "stale";
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		el.content = btoa("Y");
		await el.updateComplete;
		expect(el.error).toBeNull();
	});

	it("connectedCallback sets display:block and height:100%", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = await make("a.pdf", btoa("X"));
		expect(el.style.display).toBe("block");
		expect(el.style.height).toBe("100%");
	});

	it("renders one canvas per page (single-page PDF, covers no-separator branch)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = await make("a.pdf", btoa("X"));
		expect(el.querySelectorAll("canvas").length).toBe(1);
	});

	it("renders multiple pages with separators between them (covers pageNum < numPages branch)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}, {}, {}] };
		const el = await make("a.pdf", btoa("X"));
		const canvases = el.querySelectorAll("canvas");
		expect(canvases.length).toBe(3);
	});

	it("renderPdf error path stores error.message and renders error UI", async () => {
		pdfState.nextDocResult = { kind: "fail", error: new Error("bad pdf") };
		const el = (await make("a.pdf", btoa("X"))) as HTMLElement & {
			error: string | null;
		};
		expect(el.error).toBe("bad pdf");
		expect(el.querySelector(".bg-destructive\\/10")?.textContent).toContain("bad pdf");
	});

	it("renderPdf error path falls back to default message when error has no .message", async () => {
		pdfState.nextDocResult = { kind: "fail", error: {} };
		const el = (await make("a.pdf", btoa("X"))) as HTMLElement & { error: string | null };
		expect(el.error).toBe("Failed to load PDF");
	});

	it("getHeaderButtons returns a TemplateResult with a download button (covers decodeBase64 path)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = (await make("a.pdf", btoa("HELLO"))) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const c = document.createElement("div");
		render(el.getHeaderButtons() as never, c);
		expect(c.querySelector("button")).not.toBeNull();
	});

	it("decodes data:URL-prefixed content (covers data: branch in base64ToArrayBuffer)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const dataUrl = `data:application/pdf;base64,${btoa("DATA")}`;
		const el = await make("a.pdf", dataUrl);
		expect(el.querySelectorAll("canvas").length).toBe(1);
	});

	it("decodes data:URL-prefixed content in getHeaderButtons (covers data: branch in decodeBase64)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const dataUrl = `data:foo;base64,${btoa("ABC")}`;
		const el = (await make("a.pdf", dataUrl)) as HTMLElement & { getHeaderButtons: () => unknown };
		expect(() => el.getHeaderButtons()).not.toThrow();
	});

	it("disconnectedCallback cancels the in-flight loading task (covers cleanup branch)", async () => {
		// Trigger a re-render that destroys the previous loading task while the
		// next render is mid-flight; that exercises the destroy call.
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = await make("a.pdf", btoa("X"));
		el.currentLoadingTask = {
			destroy: () => {
				pdfState.destroyedLoadingTask = true;
			},
		};
		el.remove();
		expect(pdfState.destroyedLoadingTask).toBe(true);
	});

	it("disconnectedCallback is a no-op when no loading task is in flight (covers null guard)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = (await make("a.pdf", btoa("X"))) as HTMLElement & {
			currentLoadingTask: unknown;
		};
		el.currentLoadingTask = null;
		expect(() => el.remove()).not.toThrow();
	});

	it("renderPdf cancels a leftover loading task before starting a new one (covers existing-task destroy branch)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = (await make("a.pdf", btoa("X"))) as HTMLElement & {
			currentLoadingTask: { destroy: () => void } | null;
			content: string;
			updateComplete?: Promise<unknown>;
		};
		// Plant a stale loading task and re-trigger renderPdf with new content.
		el.currentLoadingTask = {
			destroy: () => {
				pdfState.destroyedLoadingTask = true;
			},
		};
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		el.content = btoa("Y");
		await el.updateComplete;
		await new Promise((r) => setTimeout(r, 0));
		expect(pdfState.destroyedLoadingTask).toBe(true);
	});

	it("renderPdf is a no-op when container is missing (covers early return)", async () => {
		pdfState.nextDocResult = { kind: "pages", pages: [{}] };
		const el = (await make("a.pdf", btoa("X"))) as HTMLElement & {
			updated: (m: Map<string, unknown>) => Promise<void>;
		};
		el.innerHTML = "";
		await el.updated(new Map([["_content", btoa("Y")]]));
		// Re-running updated without container is a no-op (no throw).
		expect(el.querySelectorAll("canvas").length).toBe(0);
	});

	it("renderPdf handles a page render() call returning a context-less canvas (covers !context branch)", async () => {
		// happy-dom's HTMLCanvasElement.getContext returns null by default —
		// which means !context branch is hit. Just verify the page renders without
		// throwing.
		pdfState.nextDocResult = { kind: "pages", pages: [{ render: () => ({ promise: Promise.resolve() }) }] };
		const el = await make("a.pdf", btoa("X"));
		expect(el.querySelectorAll("canvas").length).toBe(1);
	});

	it("renderPdf fills the canvas with white background when context exists (covers context truthy branch)", async () => {
		const original = HTMLCanvasElement.prototype.getContext;
		const fakeCtx = {
			fillStyle: "",
			fillRect: vi.fn(),
		};
		(HTMLCanvasElement.prototype as unknown as { getContext: (t: string) => unknown }).getContext = () => fakeCtx;
		try {
			pdfState.nextDocResult = { kind: "pages", pages: [{ render: () => ({ promise: Promise.resolve() }) }] };
			await make("a.pdf", btoa("X"));
			expect(fakeCtx.fillStyle).toBe("white");
			expect(fakeCtx.fillRect).toHaveBeenCalled();
		} finally {
			HTMLCanvasElement.prototype.getContext = original;
		}
	});
});
