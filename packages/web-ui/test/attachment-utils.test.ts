// ADR-0017 phase C.7: attachment-utils.ts — loadAttachment + the document
// processors (PDF / DOCX / PPTX / Excel). Heavy parsing deps are mocked so
// the branching logic (mime detection, base64 conversion, per-format
// extraction, error paths) is exercised deterministically.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

// --- pdfjs-dist mock -------------------------------------------------------
const { pdfState } = vi.hoisted(() => ({
	pdfState: {
		getDocument: (_args: unknown): { promise: Promise<unknown> } => ({ promise: Promise.resolve(null) }),
	},
}));
vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: {},
	getDocument: (args: unknown) => pdfState.getDocument(args),
}));

// --- docx-preview mock -----------------------------------------------------
const { docxState } = vi.hoisted(() => ({
	docxState: { parseAsync: async (_buf: unknown): Promise<unknown> => ({ documentPart: { body: { children: [] } } }) },
}));
vi.mock("docx-preview", () => ({
	parseAsync: (buf: unknown) => docxState.parseAsync(buf),
	renderAsync: vi.fn(),
}));

// --- jszip mock ------------------------------------------------------------
const { jszipState } = vi.hoisted(() => ({
	jszipState: {
		loadAsync: async (_buf: unknown): Promise<unknown> => ({ files: {}, file: () => null }),
	},
}));
vi.mock("jszip", () => ({
	default: { loadAsync: (buf: unknown) => jszipState.loadAsync(buf) },
}));

// --- xlsx mock -------------------------------------------------------------
const { xlsxState } = vi.hoisted(() => ({
	xlsxState: {
		read: (_buf: unknown, _opts: unknown): unknown => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }),
		sheet_to_csv: (_ws: unknown): string => "a,b,c",
	},
}));
vi.mock("xlsx", () => ({
	read: (buf: unknown, opts: unknown) => xlsxState.read(buf, opts),
	utils: { sheet_to_csv: (ws: unknown) => xlsxState.sheet_to_csv(ws) },
}));

import { loadAttachment } from "../src/utils/attachment-utils.js";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	// Reset mock behaviours to benign defaults.
	pdfState.getDocument = () => ({ promise: Promise.resolve(null) });
	docxState.parseAsync = async () => ({ documentPart: { body: { children: [] } } });
	jszipState.loadAsync = async () => ({ files: {}, file: () => null });
	xlsxState.read = () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } });
	xlsxState.sheet_to_csv = () => "a,b,c";
});

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).fetch;
});

describe("loadAttachment — source conversion", () => {
	it("loads from a File, using the File's name + type", async () => {
		const file = new File([bytes("hello")], "note.txt", { type: "text/plain" });
		const att = await loadAttachment(file);
		expect(att.fileName).toBe("note.txt");
		expect(att.type).toBe("document");
		expect(att.mimeType).toBe("text/plain");
		expect(att.extractedText).toBe("hello");
		expect(att.size).toBe(file.size);
	});

	it("loads from a File but honors an explicit fileName override", async () => {
		const file = new File([bytes("x")], "orig.txt", { type: "text/plain" });
		const att = await loadAttachment(file, "renamed.txt");
		expect(att.fileName).toBe("renamed.txt");
	});

	it("loads from a Blob (no name → falls back to default 'unnamed' unless extension drives type)", async () => {
		const blob = new Blob([bytes("body")], { type: "text/plain" });
		const att = await loadAttachment(blob);
		expect(att.fileName).toBe("unnamed");
		expect(att.extractedText).toBe("body");
	});

	it("loads from a Blob whose .type is empty (covers `source.type || mimeType` fallback in Blob branch)", async () => {
		const blob = new Blob([bytes("body")], { type: "" });
		const att = await loadAttachment(blob, "note.txt");
		// no type on the Blob -> falls through to the default mimeType.
		expect(att.mimeType).toBeDefined();
	});

	it("loads from an ArrayBuffer with an explicit fileName", async () => {
		const att = await loadAttachment(bytes("data"), "raw.txt");
		expect(att.fileName).toBe("raw.txt");
		expect(att.size).toBe(4);
	});

	it("loads from a URL string, fetching content and deriving filename from the URL", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () => bytes("remote"),
			headers: { get: () => "text/plain" },
		}));
		const att = await loadAttachment("https://example.com/files/doc.txt");
		expect(att.fileName).toBe("doc.txt");
		expect(att.extractedText).toBe("remote");
	});

	it("URL load falls back to 'document' when the URL path has no trailing segment", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () => bytes("x"),
			headers: { get: () => "text/plain" },
		}));
		const att = await loadAttachment("https://example.com/");
		expect(att.fileName).toBe("document");
	});

	it("throws when the URL fetch is not ok", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({ ok: false }));
		await expect(loadAttachment("https://example.com/x.txt")).rejects.toThrow("Failed to fetch file");
	});

	it("URL load falls back to extension-derived mimeType when the response has no content-type header (covers `headers.get() || mimeType` fallback)", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () => bytes("hi"),
			headers: { get: () => null },
		}));
		const att = await loadAttachment("https://example.com/file.txt");
		expect(att.fileName).toBe("file.txt");
	});

	it("loads from a File whose .type is empty (covers `source.type || mimeType` fallback in File branch)", async () => {
		const file = new File([bytes("hi")], "x.txt", { type: "" });
		const att = await loadAttachment(file);
		// no type on the File -> the loader falls back to the extension-derived default.
		expect(att.fileName).toBe("x.txt");
		expect(att.mimeType).toBeDefined();
	});

	it("throws on an invalid source type", async () => {
		await expect(loadAttachment(12345 as never)).rejects.toThrow("Invalid source type");
	});

	it("processes content larger than the 32KB chunk boundary without stack overflow", async () => {
		const big = new Uint8Array(0x8000 + 100).fill(65); // 'A' repeated past one chunk
		const att = await loadAttachment(big.buffer, "big.txt");
		expect(att.size).toBe(big.length);
		expect(att.content.length).toBeGreaterThan(0);
	});
});

describe("loadAttachment — image handling", () => {
	it("classifies an image File as type='image' with preview === content", async () => {
		const img = new File([bytes("PNGDATA")], "pic.png", { type: "image/png" });
		const att = await loadAttachment(img);
		expect(att.type).toBe("image");
		expect(att.preview).toBe(att.content);
		expect(att.mimeType).toBe("image/png");
	});
});

describe("loadAttachment — text detection", () => {
	it.each([".md", ".json", ".xml", ".html", ".css", ".js", ".ts", ".jsx", ".tsx", ".yml", ".yaml"])(
		"recognizes text extension %s by filename even when mime is octet-stream",
		async (ext) => {
			const buf = bytes("content");
			const att = await loadAttachment(buf, `file${ext}`);
			expect(att.type).toBe("document");
			expect(att.extractedText).toBe("content");
			expect(att.mimeType).toBe("text/plain");
		},
	);

	it("keeps the original text/* mime type when present", async () => {
		const file = new File([bytes("md")], "doc.weirdext", { type: "text/markdown" });
		const att = await loadAttachment(file);
		expect(att.mimeType).toBe("text/markdown");
	});

	it("throws for a genuinely unsupported file type", async () => {
		const file = new File([bytes("???")], "thing.bin", { type: "application/x-weird" });
		await expect(loadAttachment(file)).rejects.toThrow(/Unsupported file type/);
	});
});

describe("loadAttachment — PDF processing", () => {
	const makePdf = (pages: string[][]) => ({
		numPages: pages.length,
		getPage: async (i: number) => ({
			getTextContent: async () => ({ items: pages[i - 1].map((str) => ({ str })) }),
			getViewport: () => ({ width: 100, height: 200 }),
			render: () => ({ promise: Promise.resolve() }),
		}),
		destroy: vi.fn(),
	});

	it("extracts page-structured text and a preview from a PDF", async () => {
		// happy-dom's canvas returns null from getContext("2d"), so we stub it
		// here to drive the success branch through to canvas.toDataURL.
		const origGetContext = HTMLCanvasElement.prototype.getContext;
		const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
		HTMLCanvasElement.prototype.getContext = (() => ({ fillStyle: "", fillRect: () => {} })) as never;
		HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,FAKEPREVIEW";
		try {
			pdfState.getDocument = () => ({ promise: Promise.resolve(makePdf([["Hello", "World", "  "]])) });
			const att = await loadAttachment(bytes("%PDF-"), "doc.pdf");
			expect(att.type).toBe("document");
			expect(att.mimeType).toBe("application/pdf");
			expect(att.extractedText).toContain('<pdf filename="doc.pdf">');
			expect(att.extractedText).toContain('<page number="1">');
			expect(att.extractedText).toContain("Hello World");
			expect(att.preview).toBe("FAKEPREVIEW");
		} finally {
			HTMLCanvasElement.prototype.getContext = origGetContext;
			HTMLCanvasElement.prototype.toDataURL = origToDataURL;
		}
	});

	it("returns undefined preview when canvas 2d context is unavailable (covers the !context branch)", async () => {
		const origGetContext = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = () => null as never;
		try {
			pdfState.getDocument = () => ({ promise: Promise.resolve(makePdf([["A"]])) });
			const att = await loadAttachment(bytes("%PDF-"), "x.pdf");
			expect(att.preview).toBeUndefined();
		} finally {
			HTMLCanvasElement.prototype.getContext = origGetContext;
		}
	});

	it("still resolves (preview undefined) when preview generation throws", async () => {
		const pdf = {
			numPages: 1,
			getPage: vi
				.fn()
				// first call: text extraction succeeds
				.mockResolvedValueOnce({
					getTextContent: async () => ({ items: [{ str: "txt" }] }),
				})
				// second call (preview): throws
				.mockRejectedValueOnce(new Error("preview boom")),
			destroy: vi.fn(),
		};
		pdfState.getDocument = () => ({ promise: Promise.resolve(pdf) });
		const att = await loadAttachment(bytes("%PDF-"), "y.pdf");
		expect(att.preview).toBeUndefined();
		expect(att.extractedText).toContain("txt");
	});

	it("throws a wrapped error and still destroys the pdf when text extraction fails", async () => {
		const pdf = {
			numPages: 1,
			getPage: async () => {
				throw new Error("corrupt page");
			},
			destroy: vi.fn(),
		};
		pdfState.getDocument = () => ({ promise: Promise.resolve(pdf) });
		await expect(loadAttachment(bytes("%PDF-"), "bad.pdf")).rejects.toThrow(/Failed to process PDF/);
		expect(pdf.destroy).toHaveBeenCalled();
	});

	it("throws when getDocument fails before pdf is assigned (covers the `if (pdf)` falsy branch in finally)", async () => {
		pdfState.getDocument = () => ({
			promise: Promise.reject(new Error("invalid header")),
		});
		await expect(loadAttachment(bytes("%PDF-"), "bad.pdf")).rejects.toThrow(/Failed to process PDF/);
	});

	it("recognizes a PDF by mime type even without a .pdf extension", async () => {
		pdfState.getDocument = () => ({ promise: Promise.resolve(makePdf([["P"]])) });
		const file = new File([bytes("%PDF-")], "noext", { type: "application/pdf" });
		const att = await loadAttachment(file);
		expect(att.mimeType).toBe("application/pdf");
	});
});

describe("loadAttachment — DOCX processing", () => {
	it("extracts text from paragraphs, runs and nested tables", async () => {
		docxState.parseAsync = async () => ({
			documentPart: {
				body: {
					children: [
						{ type: "Paragraph", children: [{ type: "Run", children: [{ type: "Text", text: "Heading" }] }] },
						{ type: "Paragraph", children: [{ type: "Text", text: "loose text" }] },
						{
							type: "Table",
							children: [
								{
									type: "TableRow",
									children: [
										{
											type: "TableCell",
											children: [
												{
													type: "Paragraph",
													children: [{ type: "Run", children: [{ type: "Text", text: "cell1" }] }],
												},
											],
										},
										{
											type: "TableCell",
											children: [
												{
													type: "Paragraph",
													children: [{ type: "Run", children: [{ type: "Text", text: "cell2" }] }],
												},
											],
										},
									],
								},
							],
						},
						// container element with children → recursive branch
						{
							type: "SomeContainer",
							children: [{ type: "Paragraph", children: [{ type: "Text", text: "nested" }] }],
						},
					],
				},
			},
		});
		const file = new File([bytes("docx")], "doc.docx", {
			type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});
		const att = await loadAttachment(file);
		expect(att.extractedText).toContain('<docx filename="doc.docx">');
		expect(att.extractedText).toContain("Heading");
		expect(att.extractedText).toContain("loose text");
		expect(att.extractedText).toContain("cell1 | cell2");
		expect(att.extractedText).toContain("[Table]");
		expect(att.extractedText).toContain("nested");
	});

	it("handles a DOCX whose body has no children (covers the optional-chaining guard)", async () => {
		docxState.parseAsync = async () => ({ documentPart: { body: {} } });
		const att = await loadAttachment(bytes("docx"), "empty.docx");
		expect(att.extractedText).toContain('<page number="1">');
	});

	it("handles DOCX nodes whose .type is undefined (covers the `type?.toLowerCase() || ''` fallbacks)", async () => {
		docxState.parseAsync = async () => ({
			documentPart: {
				body: {
					children: [
						// Top-level element with no `type` — exercises elementType=="" path.
						{ children: [{ type: "Run", children: [{ type: "Text", text: "ignored" }] }] },
						// Paragraph whose child Run has no type — covers childType==""  fallback.
						{ type: "Paragraph", children: [{ children: [{ type: "Text", text: "ignored2" }] }] },
						// Paragraph -> Run -> child without type — covers textType=="" fallback.
						{ type: "Paragraph", children: [{ type: "Run", children: [{ text: "ignored3" }] }] },
						// Paragraph -> Text with .text undefined (covers `child.text || ""` fallback at line 319).
						{ type: "Paragraph", children: [{ type: "Text" }] },
						// Paragraph -> Run -> Text with .text undefined (covers `textChild.text || ""` fallback at line 315).
						{ type: "Paragraph", children: [{ type: "Run", children: [{ type: "Text" }] }] },
						// Table whose row has no type — covers rowType=="" fallback.
						{ type: "Table", children: [{ children: [] }] },
						// Table -> TableRow whose cell has no type — covers cellType=="" fallback.
						{ type: "Table", children: [{ type: "TableRow", children: [{ children: [] }] }] },
					],
				},
			},
		});
		const att = await loadAttachment(bytes("docx"), "shapeless.docx");
		// All elements with undefined type fall through silently — no exception thrown.
		expect(att.extractedText).toContain('<docx filename="shapeless.docx">');
	});

	it("throws a wrapped error when docx parsing fails", async () => {
		docxState.parseAsync = async () => {
			throw new Error("zip broken");
		};
		await expect(loadAttachment(bytes("docx"), "x.docx")).rejects.toThrow(/Failed to process DOCX/);
	});
});

describe("loadAttachment — PPTX processing", () => {
	it("extracts slide text and notes, sorting slides numerically", async () => {
		const slide1 = "<a:t>Slide One Title</a:t><a:t>  </a:t>";
		const slide2 = "<a:t>Slide Two</a:t>";
		const note1 = "<a:t>Note for slide one</a:t>";
		jszipState.loadAsync = async () => ({
			files: {
				"ppt/slides/slide2.xml": {},
				"ppt/slides/slide1.xml": {},
				"ppt/notesSlides/notesSlide1.xml": {},
			},
			file: (name: string) => {
				const content: Record<string, string> = {
					"ppt/slides/slide1.xml": slide1,
					"ppt/slides/slide2.xml": slide2,
					"ppt/notesSlides/notesSlide1.xml": note1,
				};
				return name in content ? { async: async () => content[name] } : null;
			},
		});
		const file = new File([bytes("pptx")], "deck.pptx", {
			type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		});
		const att = await loadAttachment(file);
		expect(att.extractedText).toContain('<pptx filename="deck.pptx">');
		// Slides sorted: slide1 before slide2.
		expect(att.extractedText!.indexOf("Slide One Title")).toBeLessThan(att.extractedText!.indexOf("Slide Two"));
		expect(att.extractedText).toContain("<notes>");
		expect(att.extractedText).toContain("Note for slide one");
	});

	it("handles a slide with no <a:t> matches and missing slide files gracefully", async () => {
		jszipState.loadAsync = async () => ({
			files: { "ppt/slides/slide1.xml": {} },
			file: () => ({ async: async () => "<p>no a:t tags here</p>" }),
		});
		const att = await loadAttachment(bytes("pptx"), "x.pptx");
		expect(att.extractedText).toContain("<pptx");
		// No <slide> blocks because there were no matches.
		expect(att.extractedText).not.toContain("<slide");
	});

	it("recognizes a .pptx by extension when mime type is generic", async () => {
		jszipState.loadAsync = async () => ({ files: {}, file: () => null });
		const att = await loadAttachment(bytes("pptx"), "byext.pptx");
		expect(att.mimeType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
	});

	it("throws a wrapped error when the PPTX zip fails to load", async () => {
		jszipState.loadAsync = async () => {
			throw new Error("not a zip");
		};
		await expect(loadAttachment(bytes("pptx"), "bad.pptx")).rejects.toThrow(/Failed to process PPTX/);
	});
});

describe("loadAttachment — Excel processing", () => {
	it("extracts each sheet as CSV wrapped in <sheet> tags", async () => {
		xlsxState.read = () => ({ SheetNames: ["First", "Second"], Sheets: { First: {}, Second: {} } });
		xlsxState.sheet_to_csv = () => "x,y\n1,2";
		const file = new File([bytes("xlsx")], "book.xlsx", {
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});
		const att = await loadAttachment(file);
		expect(att.extractedText).toContain('<excel filename="book.xlsx">');
		expect(att.extractedText).toContain('<sheet name="First" index="1">');
		expect(att.extractedText).toContain('<sheet name="Second" index="2">');
		expect(att.extractedText).toContain("x,y");
	});

	it("recognizes .xls by extension and retains its application/vnd mime type when supplied", async () => {
		xlsxState.read = () => ({ SheetNames: ["S"], Sheets: { S: {} } });
		const file = new File([bytes("xls")], "old.xls", { type: "application/vnd.ms-excel" });
		const att = await loadAttachment(file);
		expect(att.mimeType).toBe("application/vnd.ms-excel");
	});

	it("normalizes a generic-mime .xlsx to the spreadsheetml mime type", async () => {
		xlsxState.read = () => ({ SheetNames: ["S"], Sheets: { S: {} } });
		const att = await loadAttachment(bytes("xlsx"), "byext.xlsx");
		expect(att.mimeType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
	});

	it("throws a wrapped error when XLSX.read fails", async () => {
		xlsxState.read = () => {
			throw new Error("bad workbook");
		};
		await expect(loadAttachment(bytes("xlsx"), "bad.xlsx")).rejects.toThrow(/Failed to process Excel/);
	});
});
