// ADR-0017 phase C.7: AttachmentsRuntimeProvider + FileDownloadRuntimeProvider.
// Both expose getRuntime() returning a function whose body is normally
// stringified for iframe injection. We invoke the runtime function with
// a fake `window` to exercise the inner branches as coverable code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/prompts/prompts.js", () => ({ ATTACHMENTS_RUNTIME_DESCRIPTION: "ATT_DESC" }));

import { AttachmentsRuntimeProvider } from "../src/components/sandbox/AttachmentsRuntimeProvider.js";
import { FileDownloadRuntimeProvider } from "../src/components/sandbox/FileDownloadRuntimeProvider.js";

describe("AttachmentsRuntimeProvider", () => {
	const att = (id: string, content: string, extracted?: string) =>
		({
			id,
			fileName: `${id}.bin`,
			mimeType: "text/plain",
			size: content.length,
			content,
			extractedText: extracted,
			type: "document",
		}) as never;

	it("getData() serializes attachments into a plain window-installable object", () => {
		const p = new AttachmentsRuntimeProvider([att("a", "AAA"), att("b", "BBB")]);
		const data = p.getData();
		expect(data.attachments).toHaveLength(2);
		expect(data.attachments[0]).toEqual({
			id: "a",
			fileName: "a.bin",
			mimeType: "text/plain",
			size: 3,
			content: "AAA",
			extractedText: undefined,
		});
	});

	it("getDescription returns the attachments description constant", () => {
		const p = new AttachmentsRuntimeProvider([]);
		expect(p.getDescription()).toBe("ATT_DESC");
	});

	it("getRuntime returns a function (the body is opaque until invoked)", () => {
		const p = new AttachmentsRuntimeProvider([]);
		expect(typeof p.getRuntime()).toBe("function");
	});

	it("runtime: listAttachments / readTextAttachment / readBinaryAttachment cover all inner branches", () => {
		// Simulate the iframe context: a window-like object with the data installed.
		const fakeWin = { attachments: [att("x", btoa("hello"), undefined), att("y", btoa("world"), "extracted")] };
		const provider = new AttachmentsRuntimeProvider(fakeWin.attachments as never);

		// Monkey-patch globalThis as the "window" the runtime sees.
		(globalThis as Record<string, unknown>).attachments = fakeWin.attachments;
		try {
			provider.getRuntime()("sandbox-1");
			const winAny = globalThis as Record<string, (id?: string) => unknown>;

			// listAttachments: returns lightweight metadata.
			const list = winAny.listAttachments() as Array<{ id: string }>;
			expect(list.map((a) => a.id).sort()).toEqual(["x", "y"]);

			// readTextAttachment: prefers extractedText when available (covers if (a.extractedText) branch).
			expect(winAny.readTextAttachment("y")).toBe("extracted");

			// readTextAttachment: falls through to atob when no extractedText.
			expect(winAny.readTextAttachment("x")).toBe("hello");

			// readTextAttachment: unknown id throws "Attachment not found".
			expect(() => winAny.readTextAttachment("nope")).toThrow(/not found/i);

			// readTextAttachment: atob throws on bad base64 (cover catch branch).
			(globalThis as Record<string, unknown>).attachments = [{ id: "bad", content: "!!!not-b64!!!" }];
			expect(() => winAny.readTextAttachment("bad")).toThrow(/Failed to decode/);

			// readBinaryAttachment: success path.
			(globalThis as Record<string, unknown>).attachments = fakeWin.attachments;
			const bin = winAny.readBinaryAttachment("x") as Uint8Array;
			expect(bin).toBeInstanceOf(Uint8Array);
			expect(new TextDecoder().decode(bin)).toBe("hello");

			// readBinaryAttachment: unknown id throws.
			expect(() => winAny.readBinaryAttachment("nope")).toThrow(/not found/i);
		} finally {
			delete (globalThis as Record<string, unknown>).attachments;
			delete (globalThis as Record<string, unknown>).listAttachments;
			delete (globalThis as Record<string, unknown>).readTextAttachment;
			delete (globalThis as Record<string, unknown>).readBinaryAttachment;
		}
	});

	it("listAttachments returns [] when window.attachments is missing (covers || [] branch)", () => {
		(globalThis as Record<string, unknown>).attachments = undefined;
		try {
			const provider = new AttachmentsRuntimeProvider([]);
			provider.getRuntime()("sandbox-2");
			const list = (globalThis as Record<string, () => unknown>).listAttachments() as unknown[];
			expect(list).toEqual([]);
		} finally {
			delete (globalThis as Record<string, unknown>).listAttachments;
			delete (globalThis as Record<string, unknown>).readTextAttachment;
			delete (globalThis as Record<string, unknown>).readBinaryAttachment;
		}
	});

	it("readTextAttachment + readBinaryAttachment use [] fallback when window.attachments is missing (covers || [] branches at lines 42, 53)", () => {
		(globalThis as Record<string, unknown>).attachments = undefined;
		try {
			const provider = new AttachmentsRuntimeProvider([]);
			provider.getRuntime()("sandbox-3");
			const winAny = globalThis as Record<string, (id: string) => unknown>;
			// `(undefined || []).find(...)` → undefined → throws "not found".
			expect(() => winAny.readTextAttachment("any")).toThrow(/not found/i);
			expect(() => winAny.readBinaryAttachment("any")).toThrow(/not found/i);
		} finally {
			delete (globalThis as Record<string, unknown>).listAttachments;
			delete (globalThis as Record<string, unknown>).readTextAttachment;
			delete (globalThis as Record<string, unknown>).readBinaryAttachment;
		}
	});
});

describe("FileDownloadRuntimeProvider", () => {
	beforeEach(() => {
		delete (globalThis as Record<string, unknown>).sendRuntimeMessage;
		delete (globalThis as Record<string, unknown>).returnDownloadableFile;
		(globalThis as Record<string, unknown>).URL = {
			createObjectURL: () => "blob:fake",
			revokeObjectURL: () => {},
		};
	});

	afterEach(() => {
		delete (globalThis as Record<string, unknown>).sendRuntimeMessage;
		delete (globalThis as Record<string, unknown>).returnDownloadableFile;
	});

	it("getData() returns empty object", () => {
		expect(new FileDownloadRuntimeProvider().getData()).toEqual({});
	});

	it("getDescription returns a non-empty description", () => {
		expect(new FileDownloadRuntimeProvider().getDescription()).toContain("returnDownloadableFile");
	});

	it("getRuntime returns a function", () => {
		expect(typeof new FileDownloadRuntimeProvider().getRuntime()).toBe("function");
	});

	it("runtime returnDownloadableFile (offline string content) triggers browser download path", async () => {
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		// Stub anchor element click()
		const origCreate = document.createElement.bind(document);
		const clickMock = vi.fn();
		(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = (tag: string) => {
			const el = origCreate(tag);
			if (tag === "a") {
				Object.defineProperty(el, "click", { value: clickMock });
			}
			return el;
		};
		try {
			await (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile(
				"out.txt",
				"hi",
			);
			expect(clickMock).toHaveBeenCalled();
		} finally {
			(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = origCreate;
		}
	});

	it("runtime returnDownloadableFile (online) calls sendRuntimeMessage", async () => {
		const sendMock = vi.fn(async () => ({}));
		(globalThis as Record<string, unknown>).sendRuntimeMessage = sendMock;
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		await (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile(
			"out.txt",
			"hello",
			"text/plain",
		);
		expect(sendMock).toHaveBeenCalled();
	});

	it("runtime sendRuntimeMessage error response propagates as a thrown Error", async () => {
		(globalThis as Record<string, unknown>).sendRuntimeMessage = async () => ({ error: "denied" });
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		await expect(
			(globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile("x", "y"),
		).rejects.toThrow("denied");
	});

	it("runtime: Blob content with no mimeType + no blob.type throws", async () => {
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		const blob = new Blob(["data"], { type: "" });
		await expect(
			(globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile("x", blob),
		).rejects.toThrow(/MIME type is required/);
	});

	it("runtime: Blob content with explicit mimeType uses it", async () => {
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		const blob = new Blob(["data"], { type: "" });
		const origCreate = document.createElement.bind(document);
		(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = (tag: string) => {
			const el = origCreate(tag);
			if (tag === "a") Object.defineProperty(el, "click", { value: () => {} });
			return el;
		};
		try {
			await (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile(
				"x.png",
				blob,
				"image/png",
			);
		} finally {
			(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = origCreate;
		}
	});

	it("runtime: Blob with intrinsic type (no mimeType arg) uses blob.type", async () => {
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		const blob = new Blob(["data"], { type: "image/jpeg" });
		const origCreate = document.createElement.bind(document);
		(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = (tag: string) => {
			const el = origCreate(tag);
			if (tag === "a") Object.defineProperty(el, "click", { value: () => {} });
			return el;
		};
		try {
			await (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile(
				"a.jpg",
				blob,
			);
		} finally {
			(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = origCreate;
		}
	});

	it("runtime: Uint8Array without mimeType throws", async () => {
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		await expect(
			(globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile(
				"x.bin",
				new Uint8Array([1, 2, 3]),
			),
		).rejects.toThrow(/MIME type is required/);
	});

	it("runtime: Uint8Array WITH mimeType succeeds (offline path)", async () => {
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		const origCreate = document.createElement.bind(document);
		(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = (tag: string) => {
			const el = origCreate(tag);
			if (tag === "a") Object.defineProperty(el, "click", { value: () => {} });
			return el;
		};
		try {
			await (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile(
				"x.bin",
				new Uint8Array([1, 2, 3]),
				"application/octet-stream",
			);
		} finally {
			(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = origCreate;
		}
	});

	it("runtime: object content stringifies as JSON with default mimeType", async () => {
		new FileDownloadRuntimeProvider().getRuntime()("sb");
		const origCreate = document.createElement.bind(document);
		(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = (tag: string) => {
			const el = origCreate(tag);
			if (tag === "a") Object.defineProperty(el, "click", { value: () => {} });
			return el;
		};
		try {
			await (globalThis as Record<string, (...a: unknown[]) => Promise<unknown>>).returnDownloadableFile("x.json", {
				k: 1,
			});
		} finally {
			(document as unknown as { createElement: (tag: string) => HTMLElement }).createElement = origCreate;
		}
	});

	it("handleMessage with type='file-returned' collects the file and responds success", async () => {
		const p = new FileDownloadRuntimeProvider();
		const respond = vi.fn();
		await p.handleMessage(
			{ type: "file-returned", fileName: "x.txt", content: "hi", mimeType: "text/plain" },
			respond,
		);
		expect(respond).toHaveBeenCalledWith({ success: true });
		expect(p.getFiles()).toHaveLength(1);
		p.reset();
		expect(p.getFiles()).toEqual([]);
	});

	it("handleMessage with a different type does NOT collect a file", async () => {
		const p = new FileDownloadRuntimeProvider();
		const respond = vi.fn();
		await p.handleMessage({ type: "other-message" }, respond);
		expect(p.getFiles()).toEqual([]);
		expect(respond).not.toHaveBeenCalled();
	});
});
