// ADR-0017 phase C.7: AttachmentTile.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit/dist/icons.js", () => ({ icon: () => "<icon/>" }));
vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("../src/dialogs/AttachmentOverlay.js", () => ({
	AttachmentOverlay: { open: openMock },
}));

import "../src/components/AttachmentTile.js";
import type { Attachment } from "../src/utils/attachment-utils.js";

afterEach(() => {
	document.body.innerHTML = "";
	openMock.mockClear();
});

const make = async (
	attachment: Attachment,
	opts: { showDelete?: boolean; onDelete?: () => void } = {},
): Promise<HTMLElement> => {
	const el = document.createElement("attachment-tile") as HTMLElement & {
		attachment: Attachment;
		showDelete: boolean;
		onDelete?: () => void;
		updateComplete?: Promise<unknown>;
	};
	el.attachment = attachment;
	el.showDelete = opts.showDelete ?? false;
	el.onDelete = opts.onDelete;
	document.body.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	return el;
};

const imgAttachment: Attachment = {
	id: "1",
	fileName: "photo.png",
	type: "image",
	mimeType: "image/png",
	preview: "BASE64DATA",
	size: 100,
} as Attachment;

const pdfAttachment: Attachment = {
	id: "2",
	fileName: "report.pdf",
	type: "document",
	mimeType: "application/pdf",
	preview: "BASE64PDF",
	size: 200,
} as Attachment;

const excelAttachment: Attachment = {
	id: "3",
	fileName: "data.xlsx",
	type: "document",
	mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	size: 300,
} as Attachment;

const xlsAttachment: Attachment = {
	id: "4",
	fileName: "OLD-FILE.XLS",
	type: "document",
	mimeType: "application/vnd.ms-excel",
	size: 50,
} as Attachment;

const docNoPreview: Attachment = {
	id: "5",
	fileName: "verylongfilename-many-chars.docx",
	type: "document",
	mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	size: 75,
} as Attachment;

const shortNameNoPreview: Attachment = {
	id: "6",
	fileName: "a.txt",
	type: "document",
	mimeType: "text/plain",
	size: 5,
} as Attachment;

describe("AttachmentTile", () => {
	it("renders an image preview with mimeType-derived src and the filename in alt/title", async () => {
		const el = await make(imgAttachment);
		const img = el.querySelector("img");
		expect(img).not.toBeNull();
		expect(img!.alt).toBe("photo.png");
		expect(img!.title).toBe("photo.png");
		expect(img!.src).toContain("data:image/png;base64,BASE64DATA");
	});

	it("renders a PDF badge overlay when mimeType is application/pdf", async () => {
		const el = await make(pdfAttachment);
		// PDF tile uses preview path but with image/png fallback src + PDF badge.
		const img = el.querySelector("img");
		expect(img!.src).toContain("data:image/png;base64,");
		expect(el.textContent).toContain("PDF");
	});

	it("renders a document fallback when there is no preview (with truncated long filename)", async () => {
		const el = await make(docNoPreview);
		expect(el.querySelector("img")).toBeNull();
		// Long filename gets truncated to "filename..." (first 8 chars + ellipsis).
		expect(el.textContent).toContain("verylong");
		expect(el.textContent).toContain("...");
	});

	it("renders the full filename when 10 chars or fewer", async () => {
		const el = await make(shortNameNoPreview);
		expect(el.textContent).toContain("a.txt");
		expect(el.textContent).not.toContain("...");
	});

	it("uses the spreadsheet icon for xlsx files (mimetype path)", async () => {
		const el = await make({ ...excelAttachment, preview: undefined } as Attachment);
		// The icon mock returns a string; we just confirm the fallback render path executes.
		expect(el.querySelector("img")).toBeNull();
		expect(el.textContent).toContain("data.xlsx");
	});

	it("uses the spreadsheet icon for .xls files (extension path, case-insensitive)", async () => {
		const el = await make({ ...xlsAttachment, preview: undefined } as Attachment);
		expect(el.querySelector("img")).toBeNull();
	});

	it("clicking the image opens AttachmentOverlay with the attachment", async () => {
		const el = await make(imgAttachment);
		const img = el.querySelector("img") as HTMLImageElement;
		img.click();
		expect(openMock).toHaveBeenCalledWith(imgAttachment);
	});

	it("clicking the document fallback also opens AttachmentOverlay", async () => {
		const el = await make(docNoPreview);
		const docBox = el.querySelector('[title="verylongfilename-many-chars.docx"]') as HTMLElement;
		expect(docBox).not.toBeNull();
		docBox.click();
		expect(openMock).toHaveBeenCalled();
	});

	it("does not render delete button when showDelete is false", async () => {
		const el = await make(imgAttachment, { showDelete: false });
		expect(el.querySelector("button")).toBeNull();
	});

	it("renders delete button when showDelete is true and invokes onDelete (stopping propagation)", async () => {
		const onDelete = vi.fn();
		const el = await make(imgAttachment, { showDelete: true, onDelete });
		const btn = el.querySelector("button") as HTMLButtonElement;
		expect(btn).not.toBeNull();
		btn.click();
		expect(onDelete).toHaveBeenCalled();
		// The image click should NOT also fire due to stopPropagation.
		expect(openMock).not.toHaveBeenCalled();
	});

	it("delete button without onDelete handler is a no-op (?.() branch)", async () => {
		const el = await make(imgAttachment, { showDelete: true });
		const btn = el.querySelector("button") as HTMLButtonElement;
		btn.click(); // shouldn't throw
		expect(openMock).not.toHaveBeenCalled();
	});

	it("connectedCallback sets style.display='block' and adds max-h-16 class", async () => {
		const el = await make(imgAttachment);
		expect(el.style.display).toBe("block");
		expect(el.classList.contains("max-h-16")).toBe(true);
	});
});
