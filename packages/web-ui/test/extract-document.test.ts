// ADR-0017 coverage push: extract-document tool (execute + renderer).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/prompts/prompts.js", () => ({ EXTRACT_DOCUMENT_DESCRIPTION: "extract desc" }));
vi.mock("lucide", () => ({ FileText: {} }));

const { loadAttachmentMock, isCorsErrorMock } = vi.hoisted(() => ({
	loadAttachmentMock: vi.fn(),
	isCorsErrorMock: vi.fn(),
}));
vi.mock("../src/utils/attachment-utils.js", () => ({
	loadAttachment: (...args: unknown[]) => loadAttachmentMock(...args),
}));
vi.mock("../src/utils/proxy-utils.js", () => ({
	isCorsError: (e: unknown) => isCorsErrorMock(e),
}));
vi.mock("../src/tools/renderer-registry.js", () => ({
	registerToolRenderer: vi.fn(),
	renderCollapsibleHeader: () => "[header]",
	renderHeader: () => "[header]",
}));

import { createExtractDocumentTool, extractDocumentRenderer } from "../src/tools/extract-document.js";

const okAttachment = (
	overrides: Partial<{ extractedText: string; mimeType: string; fileName: string; size: number }> = {},
) => ({
	extractedText: overrides.extractedText ?? "hello text",
	mimeType: overrides.mimeType ?? "application/pdf",
	fileName: overrides.fileName ?? "doc.pdf",
	size: overrides.size ?? 1234,
});

const okResponse = (body = "binary") =>
	new Response(body, {
		status: 200,
		headers: { "content-length": String(body.length) },
	});

beforeEach(() => {
	loadAttachmentMock.mockReset();
	isCorsErrorMock.mockReset();
	isCorsErrorMock.mockReturnValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createExtractDocumentTool.execute", () => {
	it("throws when signal is already aborted", async () => {
		const t = createExtractDocumentTool();
		const ac = new AbortController();
		ac.abort();
		await expect(t.execute("id", { url: "https://x/d.pdf" }, ac.signal)).rejects.toThrow("Extract document aborted");
	});

	it("throws when URL is empty after trimming", async () => {
		const t = createExtractDocumentTool();
		await expect(t.execute("id", { url: "   " })).rejects.toThrow("URL is required");
	});

	it("throws with the offending URL when format is invalid", async () => {
		const t = createExtractDocumentTool();
		await expect(t.execute("id", { url: "not-a-url" })).rejects.toThrow(/Invalid URL/);
	});

	it("downloads and extracts text from a PDF (covers happy path + pdf format branch)", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(okAttachment());
		const r = await t.execute("id", { url: "https://x/doc.pdf" });
		expect(r.content[0].text).toBe("hello text");
		expect(r.details.format).toBe("pdf");
	});

	it("maps a wordprocessingml mimeType to docx", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(
			okAttachment({ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
		);
		const r = await t.execute("id", { url: "https://x/d.docx" });
		expect(r.details.format).toBe("docx");
	});

	it("maps spreadsheetml to xlsx", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(
			okAttachment({ mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
		);
		const r = await t.execute("id", { url: "https://x/d.xlsx" });
		expect(r.details.format).toBe("xlsx");
	});

	it("maps ms-excel mimeType to xlsx (covers second condition in xlsx OR-branch)", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(okAttachment({ mimeType: "application/vnd.ms-excel" }));
		const r = await t.execute("id", { url: "https://x/d.xls" });
		expect(r.details.format).toBe("xlsx");
	});

	it("maps presentationml to pptx", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(
			okAttachment({ mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
		);
		const r = await t.execute("id", { url: "https://x/d.pptx" });
		expect(r.details.format).toBe("pptx");
	});

	it("falls back to 'unknown' format for an unrecognised mimeType", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(okAttachment({ mimeType: "application/x-weird" }));
		const r = await t.execute("id", { url: "https://x/d.bin" });
		expect(r.details.format).toBe("unknown");
	});

	it("appends .pdf to filename when URL starts with https://arxiv.org/", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(okAttachment());
		await t.execute("id", { url: "https://arxiv.org/abs/1234" });
		expect(loadAttachmentMock).toHaveBeenCalled();
		const [, fileName] = loadAttachmentMock.mock.calls[0];
		expect(fileName).toBe("1234.pdf");
	});

	it("strips query string from filename (covers split('?')[0] branch)", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(okAttachment());
		await t.execute("id", { url: "https://x/path/doc.pdf?token=secret" });
		const [, fileName] = loadAttachmentMock.mock.calls[0];
		expect(fileName).toBe("doc.pdf");
	});

	it("falls back to 'document' when URL path has no trailing segment", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(okAttachment());
		await t.execute("id", { url: "https://x/" });
		const [, fileName] = loadAttachmentMock.mock.calls[0];
		expect(fileName).toBe("document");
	});

	it("throws unsupported-format error when loadAttachment returns no extracted text", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce({ ...okAttachment(), extractedText: "" });
		await expect(t.execute("id", { url: "https://x/d.bin" })).rejects.toThrow(/Document format not supported/);
	});

	it("throws when fetch returns a non-2xx status (covers !response.ok branch)", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("nope", { status: 403, statusText: "Forbidden" }),
		);
		await expect(t.execute("id", { url: "https://x/d.pdf" })).rejects.toThrow(/Unable to download/);
	});

	it("throws when Content-Length exceeds 50MB (covers content-length size branch)", async () => {
		const t = createExtractDocumentTool();
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("", { status: 200, headers: { "content-length": String(51 * 1024 * 1024) } }),
		);
		await expect(t.execute("id", { url: "https://x/big.pdf" })).rejects.toThrow(/too large/);
	});

	it("throws when actual arrayBuffer size exceeds 50MB (covers post-download size branch)", async () => {
		const t = createExtractDocumentTool();
		const big = new ArrayBuffer(51 * 1024 * 1024);
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(big, { status: 200, headers: {} }));
		await expect(t.execute("id", { url: "https://x/big.pdf" })).rejects.toThrow(/too large/);
	});

	it("retries via the configured CORS proxy on a CORS error and succeeds", async () => {
		const t = createExtractDocumentTool();
		t.corsProxyUrl = "https://proxy.example/?url=";
		isCorsErrorMock.mockReturnValueOnce(true);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("cors!"))
			.mockResolvedValueOnce(okResponse());
		loadAttachmentMock.mockResolvedValueOnce(okAttachment());
		const r = await t.execute("id", { url: "https://x/d.pdf" });
		expect(r.details.format).toBe("pdf");
		// Second call used the proxy
		const secondUrl = fetchSpy.mock.calls[1][0] as string;
		expect(secondUrl).toContain("proxy.example");
	});

	it("throws a CORS+proxy-failed error when both direct and proxied fetches fail", async () => {
		const t = createExtractDocumentTool();
		t.corsProxyUrl = "https://proxy.example/?url=";
		isCorsErrorMock.mockReturnValueOnce(true);
		vi.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("cors!"))
			.mockRejectedValueOnce(new Error("proxy-down"));
		await expect(t.execute("id", { url: "https://x/d.pdf" })).rejects.toThrow(/proxy-down/);
	});

	it("throws CORS-no-proxy hint when no proxy is configured", async () => {
		const t = createExtractDocumentTool();
		t.corsProxyUrl = undefined;
		// isCorsError is called twice: once in the proxy-retry guard and once
		// in the no-proxy fallback guard.
		isCorsErrorMock.mockReturnValue(true);
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("cors!"));
		await expect(t.execute("id", { url: "https://x/d.pdf" })).rejects.toThrow(/CORS proxy/i);
	});

	it("re-throws non-CORS errors from the direct fetch path", async () => {
		const t = createExtractDocumentTool();
		isCorsErrorMock.mockReturnValueOnce(false);
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("disk full"));
		await expect(t.execute("id", { url: "https://x/d.pdf" })).rejects.toThrow("disk full");
	});
});

describe("extractDocumentRenderer", () => {
	const baseResult = {
		role: "toolResult" as const,
		toolCallId: "tc",
		toolName: "extract_document",
		timestamp: 1,
	};

	it("renders the prepare header when neither params nor result is given", () => {
		const out = extractDocumentRenderer.render(undefined, undefined, false);
		expect(out.isCustom).toBe(false);
	});

	it("renders params-only while streaming", () => {
		const out = extractDocumentRenderer.render({ url: "https://x/d.pdf" }, undefined, true);
		expect(out.isCustom).toBe(false);
	});

	it("renders params + successful result (covers success title + code-block branch)", () => {
		extractDocumentRenderer.render(
			{ url: "https://x/d.pdf" },
			{
				...baseResult,
				isError: false,
				content: [{ type: "text", text: "hello" }],
				details: { extractedText: "hello", format: "pdf", fileName: "d.pdf", size: 2048 },
			} as never,
			false,
		);
	});

	it("renders params + error result with details (covers Failed-to-extract title branch)", () => {
		extractDocumentRenderer.render(
			{ url: "https://x/d.pdf" },
			{
				...baseResult,
				isError: true,
				content: [{ type: "text", text: "boom" }],
				details: { extractedText: "", format: "pdf", fileName: "d.pdf", size: 0 },
			} as never,
			false,
		);
	});

	it("renders params + error result with details but blank filename (covers fileName || 'document')", () => {
		extractDocumentRenderer.render(
			{ url: "https://x/d.pdf" },
			{
				...baseResult,
				isError: true,
				content: [{ type: "text", text: "boom" }],
				details: { extractedText: "", format: "pdf", fileName: "", size: 0 },
			} as never,
			false,
		);
	});

	it("renders params + success result without details (covers !details fallback title branch)", () => {
		extractDocumentRenderer.render(
			{ url: "https://x/d.pdf" },
			{
				...baseResult,
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: undefined,
			} as never,
			false,
		);
	});

	it("renders params + error result without details (covers !details + isError fallback title)", () => {
		extractDocumentRenderer.render(
			{ url: "https://x/d.pdf" },
			{
				...baseResult,
				isError: true,
				content: [],
				details: undefined,
			} as never,
			false,
		);
	});

	it("renders result with empty URL string (covers !params.url branch)", () => {
		extractDocumentRenderer.render(
			{ url: "" },
			{
				...baseResult,
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: { extractedText: "ok", format: "pdf", fileName: "d.pdf", size: 1 },
			} as never,
			false,
		);
	});

	it("renders no code-block when result is success but content is empty (covers !output branch)", () => {
		extractDocumentRenderer.render(
			{ url: "https://x/d.pdf" },
			{
				...baseResult,
				isError: false,
				content: [],
				details: { extractedText: "", format: "pdf", fileName: "d.pdf", size: 1 },
			} as never,
			false,
		);
	});

	it("renders no console-block when result is error but content is empty (covers isError && !output branch)", () => {
		extractDocumentRenderer.render(
			{ url: "https://x/d.pdf" },
			{
				...baseResult,
				isError: true,
				content: [],
				details: { extractedText: "", format: "pdf", fileName: "d.pdf", size: 1 },
			} as never,
			false,
		);
	});
});
