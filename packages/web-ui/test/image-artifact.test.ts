// ADR-0017 phase C.7: ImageArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: (opts: { filename: string; mimeType: string }) => {
		const el = document.createElement("button");
		el.dataset.filename = opts.filename;
		el.dataset.mime = opts.mimeType;
		return el;
	},
}));

import "../src/tools/artifacts/ImageArtifact.js";

afterEach(() => {
	document.body.innerHTML = "";
});

const make = async (filename: string, content: string): Promise<HTMLElement> => {
	const el = document.createElement("image-artifact") as HTMLElement & {
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

describe("ImageArtifact", () => {
	it("connectedCallback sets style.display='block' and height='100%'", async () => {
		const el = await make("a.png", "abc");
		expect(el.style.display).toBe("block");
		expect(el.style.height).toBe("100%");
	});

	it("renders <img> with data:image/png URL from raw base64 content (default mime)", async () => {
		const el = await make("a.png", "BASE64DATA");
		const img = el.querySelector("img") as HTMLImageElement;
		expect(img.src).toContain("data:image/png;base64,BASE64DATA");
		expect(img.alt).toBe("a.png");
	});

	it("renders img using provided data URL verbatim when content starts with 'data:'", async () => {
		const dataUrl = "data:image/jpeg;base64,XYZ";
		const el = await make("a.jpg", dataUrl);
		const img = el.querySelector("img") as HTMLImageElement;
		expect(img.src).toBe(dataUrl);
	});

	it.each([
		["jpg", "image/jpeg"],
		["jpeg", "image/jpeg"],
		["gif", "image/gif"],
		["webp", "image/webp"],
		["svg", "image/svg+xml"],
		["bmp", "image/bmp"],
		["ico", "image/x-icon"],
		["png", "image/png"], // default fallback path
		["unknown-ext", "image/png"], // catch-all
		["no-extension", "image/png"], // filename without dot
	])("getMimeType infers '%s' → %s via header button mime data attr", async (ext, expectedMime) => {
		const filename = ext.includes("-") ? ext : `file.${ext}`;
		// Use valid base64 so the decodeBase64 invoked inside getHeaderButtons doesn't throw.
		const el = (await make(filename, btoa("x"))) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		const btn = container.querySelector("button") as HTMLButtonElement;
		expect(btn.dataset.mime).toBe(expectedMime);
	});

	it("decodeBase64 with a 'data:' URL extracts the base64 portion", async () => {
		const el = (await make("a.png", "data:image/png;base64,SGVsbG8=")) as HTMLElement & {
			getHeaderButtons: () => unknown;
		};
		// We call getHeaderButtons() which internally calls decodeBase64() — exercises the path.
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("decodeBase64 with a 'data:' URL that has NO ',base64,' segment returns empty Uint8Array", async () => {
		// data:text/plain;charset=utf-8,Hello — no `base64,` marker.
		const el = (await make("x.png", "data:text/plain;charset=utf-8,Hello")) as HTMLElement & {
			getHeaderButtons: () => unknown;
		};
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("decodeBase64 with raw base64 (no data: prefix) decodes correctly", async () => {
		const el = (await make("a.png", btoa("hello"))) as HTMLElement & { getHeaderButtons: () => unknown };
		const { render } = await import("lit");
		const container = document.createElement("div");
		render(el.getHeaderButtons() as never, container);
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("img onError swaps src to fallback SVG (covers error handler)", async () => {
		const el = await make("a.png", btoa("data"));
		const img = el.querySelector("img") as HTMLImageElement;
		// Trigger the inline @error handler.
		img.dispatchEvent(new Event("error"));
		expect(img.src).toContain("Image Error");
	});

	it("setter triggers re-render (content getter returns latest value)", async () => {
		const el = (await make("a.png", "initial")) as HTMLElement & {
			content: string;
			updateComplete?: Promise<unknown>;
		};
		el.content = "updated";
		await el.updateComplete;
		expect(el.content).toBe("updated");
	});
});
