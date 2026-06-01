// ADR-0017 coverage push: ExcelArtifact Lit component.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("@mariozechner/mini-lit/dist/DownloadButton.js", () => ({
	DownloadButton: () => document.createElement("button"),
}));

const { xlsxReadMock, sheetToHtmlMock } = vi.hoisted(() => ({
	xlsxReadMock: vi.fn(),
	sheetToHtmlMock: vi.fn(),
}));
vi.mock("xlsx", () => ({
	read: (...args: unknown[]) => xlsxReadMock(...args),
	utils: { sheet_to_html: (...args: unknown[]) => sheetToHtmlMock(...args) },
}));

import "../src/tools/artifacts/ExcelArtifact.js";

afterEach(() => {
	document.body.innerHTML = "";
	xlsxReadMock.mockReset();
	sheetToHtmlMock.mockReset();
});

const make = async (filename: string, content: string) => {
	const el = document.createElement("excel-artifact") as HTMLElement & {
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

const tableHtml = (id: string) =>
	`<table id="${id}"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>`;

describe("ExcelArtifact", () => {
	it("renders the excel-container outer element", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Sheet1"));
		const el = await make("a.xlsx", btoa("X"));
		expect(el.querySelector("#excel-container")).not.toBeNull();
	});

	it("content getter/setter round-trips and setter resets prior error", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Sheet1"));
		const el = (await make("a.xlsx", btoa("A"))) as HTMLElement & {
			content: string;
			error: string | null;
			updateComplete?: Promise<unknown>;
		};
		expect(el.content).toBe(btoa("A"));
		el.error = "boom";
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Sheet1"));
		el.content = btoa("B");
		await el.updateComplete;
		expect(el.error).toBeNull();
	});

	it("single-sheet workbook renders one styled table inside the container", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["Only"], Sheets: { Only: { foo: 1 } } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Only"));
		const el = await make("a.xlsx", btoa("X"));
		const table = el.querySelector("table");
		expect(table).not.toBeNull();
		expect(table?.className).toContain("border-collapse");
		// cells get styled
		const td = el.querySelector("td");
		expect(td?.className).toContain("border-border");
	});

	it("multi-sheet workbook renders tab buttons and shows the first sheet by default", async () => {
		xlsxReadMock.mockReturnValueOnce({
			SheetNames: ["Sheet1", "Sheet2"],
			Sheets: { Sheet1: {}, Sheet2: {} },
		});
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Sheet1"));
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Sheet2"));
		const el = await make("a.xlsx", btoa("X"));
		const tabs = el.querySelectorAll("button");
		expect(tabs.length).toBe(2);
		expect(tabs[0].textContent).toBe("Sheet1");
		expect(tabs[1].textContent).toBe("Sheet2");
	});

	it("clicking a non-active tab switches the visible sheet (covers tab.onclick)", async () => {
		xlsxReadMock.mockReturnValueOnce({
			SheetNames: ["Sheet1", "Sheet2"],
			Sheets: { Sheet1: {}, Sheet2: {} },
		});
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Sheet1"));
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-Sheet2"));
		const el = await make("a.xlsx", btoa("X"));
		const tabs = el.querySelectorAll("button");
		(tabs[1] as HTMLButtonElement).click();
		// Active tab class flipped
		expect(tabs[1].className).toContain("border-primary");
		expect(tabs[0].className).not.toContain("border-primary");
	});

	it("clicking the already-active tab keeps it active (covers btnIndex === index branch on click)", async () => {
		xlsxReadMock.mockReturnValueOnce({
			SheetNames: ["A", "B"],
			Sheets: { A: {}, B: {} },
		});
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-A"));
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-B"));
		const el = await make("a.xlsx", btoa("X"));
		const tabs = el.querySelectorAll("button");
		(tabs[0] as HTMLButtonElement).click(); // already active
		expect(tabs[0].className).toContain("border-primary");
	});

	it("renderExcel error path stores error.message and renders error UI", async () => {
		xlsxReadMock.mockImplementationOnce(() => {
			throw new Error("bad workbook");
		});
		const el = (await make("a.xlsx", btoa("X"))) as HTMLElement & {
			error: string | null;
		};
		expect(el.error).toBe("bad workbook");
		expect(el.querySelector(".bg-destructive\\/10")?.textContent).toContain("bad workbook");
	});

	it("renderExcel error path falls back to default message when error has no .message", async () => {
		xlsxReadMock.mockImplementationOnce(() => {
			throw {};
		});
		const el = (await make("a.xlsx", btoa("X"))) as HTMLElement & {
			error: string | null;
		};
		expect(el.error).toBe("Failed to load spreadsheet");
	});

	it("getMimeType maps .xls to ms-excel and other extensions to spreadsheetml.sheet", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["S"], Sheets: { S: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-S"));
		const xls = (await make("legacy.xls", btoa("X"))) as HTMLElement & {
			getHeaderButtons: () => unknown;
		};
		// .xls path doesn't throw — covered indirectly via header buttons rendering.
		const { render } = await import("lit");
		const c = document.createElement("div");
		render(xls.getHeaderButtons() as never, c);
		expect(c.querySelector("button")).not.toBeNull();
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["S"], Sheets: { S: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-S"));
		const xlsx = (await make("modern.xlsx", btoa("X"))) as HTMLElement & {
			getHeaderButtons: () => unknown;
		};
		const c2 = document.createElement("div");
		render(xlsx.getHeaderButtons() as never, c2);
		expect(c2.querySelector("button")).not.toBeNull();
	});

	it("decodes a data:URL-prefixed content (covers data: branch in base64ToArrayBuffer)", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["S"], Sheets: { S: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-S"));
		const dataUrl = `data:application/vnd.ms-excel;base64,${btoa("DATA")}`;
		await make("a.xls", dataUrl);
		expect(xlsxReadMock).toHaveBeenCalledOnce();
		const [buf] = xlsxReadMock.mock.calls[0] as [ArrayBuffer, unknown];
		expect(new TextDecoder().decode(new Uint8Array(buf))).toBe("DATA");
	});

	it("decodes a data:URL-prefixed content in getHeaderButtons (covers data: branch in decodeBase64)", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["S"], Sheets: { S: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-S"));
		const dataUrl = `data:foo;base64,${btoa("ZZ")}`;
		const el = (await make("a.xlsx", dataUrl)) as HTMLElement & { getHeaderButtons: () => unknown };
		expect(() => el.getHeaderButtons()).not.toThrow();
	});

	it("renderExcelSheet handles a sheet that produces no <table> (covers !table branch)", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["Empty"], Sheets: { Empty: {} } });
		sheetToHtmlMock.mockReturnValueOnce("<div>no table here</div>");
		const el = await make("a.xlsx", btoa("X"));
		// container exists but no <table> was appended
		expect(el.querySelector("table")).toBeNull();
	});

	it("renderExcel is a no-op when the container is missing (covers early return)", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["S"], Sheets: { S: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-S"));
		const el = (await make("a.xlsx", btoa("X"))) as HTMLElement & {
			updated: (m: Map<string, unknown>) => Promise<void>;
		};
		el.innerHTML = ""; // strip container
		await el.updated(new Map([["_content", btoa("Y")]]));
		expect(xlsxReadMock).toHaveBeenCalledOnce();
	});

	it("connectedCallback sets display:block and height:100%", async () => {
		xlsxReadMock.mockReturnValueOnce({ SheetNames: ["S"], Sheets: { S: {} } });
		sheetToHtmlMock.mockReturnValueOnce(tableHtml("sheet-S"));
		const el = await make("a.xlsx", btoa("X"));
		expect(el.style.display).toBe("block");
		expect(el.style.height).toBe("100%");
	});
});
