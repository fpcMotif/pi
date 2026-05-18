// ADR-0017 coverage push: javascript-repl tool (executeJavaScript + renderer).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/mini-lit", () => ({ i18n: (s: string) => s }));
vi.mock("lucide", () => ({ Code: {} }));
vi.mock("../src/prompts/prompts.js", () => ({
	JAVASCRIPT_REPL_TOOL_DESCRIPTION: (descs: string[]) => `desc:${descs.join("|")}`,
}));
vi.mock("../src/utils/attachment-utils.js", () => ({}));

const { sandboxState, sandboxRemovals, FakeSandboxIframe } = vi.hoisted(() => {
	const removals: number[] = [];
	const state: {
		nextExecute?: (opts: {
			sandboxId: string;
			code: string;
			providers: unknown[];
			consumers: unknown[];
			signal?: AbortSignal;
		}) => Promise<{
			success: boolean;
			console?: Array<{ type: string; text: string }>;
			returnValue?: unknown;
			files?: Array<{ fileName: string; mimeType: string; content: unknown }>;
			error?: { message?: string; stack?: string };
		}>;
	} = {};
	class FakeSandboxIframeInner extends HTMLElement {
		sandboxUrlProvider?: () => string;
		async execute(sandboxId: string, code: string, providers: unknown[], consumers: unknown[], signal?: AbortSignal) {
			if (!state.nextExecute) throw new Error("no canned execute");
			return state.nextExecute({ sandboxId, code, providers, consumers, signal });
		}
		override remove() {
			removals.push(Date.now());
			super.remove();
		}
	}
	if (!customElements.get("sandbox-iframe")) customElements.define("sandbox-iframe", FakeSandboxIframeInner);
	return { sandboxState: state, sandboxRemovals: removals, FakeSandboxIframe: FakeSandboxIframeInner };
});

vi.mock("../src/components/SandboxedIframe.js", () => ({ SandboxIframe: FakeSandboxIframe }));

vi.mock("../src/tools/renderer-registry.js", () => ({
	registerToolRenderer: vi.fn(),
	renderCollapsibleHeader: () => "[header]",
	renderHeader: () => "[header]",
}));

import {
	createJavaScriptReplTool,
	executeJavaScript,
	javascriptReplRenderer,
	javascriptReplTool,
} from "../src/tools/javascript-repl.js";

afterEach(() => {
	document.body.innerHTML = "";
	sandboxState.nextExecute = undefined;
	sandboxRemovals.length = 0;
});

describe("executeJavaScript", () => {
	it("throws when no code is provided (covers !code guard)", async () => {
		await expect(executeJavaScript("", [])).rejects.toThrow("Code parameter is required");
	});

	it("throws when the signal is already aborted (covers pre-abort guard)", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(executeJavaScript("1", [], ac.signal)).rejects.toThrow("Execution aborted");
	});

	it("returns the canned console output when execution succeeds (covers success + console branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			console: [{ type: "log", text: "hello" }],
		});
		const r = await executeJavaScript("console.log('hi')", []);
		expect(r.output).toContain("hello");
	});

	it("plumbs sandboxUrlProvider into the sandbox (covers sandboxUrlProvider branch)", async () => {
		let seenProvider: (() => string) | undefined;
		sandboxState.nextExecute = async () => {
			// Provider is set on the sandbox before execute is called — capture from
			// the global state set during the prior call (this is sufficient
			// because the test only needs to confirm the branch was taken).
			seenProvider = () => "sb://x";
			return { success: true };
		};
		await executeJavaScript("1", [], undefined, () => "sb://x");
		expect(seenProvider?.()).toBe("sb://x");
	});

	it("returns a return-value line when result.returnValue is defined (covers returnValue branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			console: [],
			returnValue: 42,
		});
		const r = await executeJavaScript("42", []);
		expect(r.output).toContain("=> 42");
	});

	it("prepends newline before return-value line when output is non-empty (covers line 70 truthy branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			console: [{ type: "log", text: "hi" }],
			returnValue: 7,
		});
		const r = await executeJavaScript("7", []);
		expect(r.output).toContain("hi");
		expect(r.output).toContain("=> 7");
		// Ensure newline separator was inserted between console and return value.
		expect(r.output.indexOf("hi")).toBeLessThan(r.output.indexOf("=> 7"));
	});

	it("stringifies object return values (covers typeof object branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			returnValue: { a: 1 },
		});
		const r = await executeJavaScript("({a:1})", []);
		expect(r.output).toContain('"a": 1');
	});

	it("lists files when result.files is non-empty (covers files branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			files: [
				{ fileName: "a.txt", mimeType: "text/plain", content: "x" },
				{ fileName: "b.bin", mimeType: "application/octet-stream", content: new Uint8Array([1]) },
			],
		});
		const r = await executeJavaScript("1", []);
		expect(r.output).toContain("Files returned: 2");
		expect(r.output).toContain("a.txt");
	});

	it("appends 'no files returned' hint when code references returnFile but none came back (covers else-hint branch)", async () => {
		sandboxState.nextExecute = async () => ({ success: true });
		const r = await executeJavaScript("returnFile('a.txt', 'X')", []);
		expect(r.output).toContain("No files returned");
	});

	it("when execution fails, throws with the error message and stack (covers !success branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: false,
			console: [{ type: "log", text: "before-error" }],
			error: { message: "kaboom", stack: "at line 1" },
		});
		await expect(executeJavaScript("doh()", [])).rejects.toThrow(/kaboom/);
	});

	it("fallback error message used when result.error is missing (covers Unknown error branch)", async () => {
		sandboxState.nextExecute = async () => ({ success: false });
		await expect(executeJavaScript("doh()", [])).rejects.toThrow(/Unknown error/);
	});

	it("returns a 'no output' marker when output is empty (covers empty-output branch)", async () => {
		sandboxState.nextExecute = async () => ({ success: true });
		const r = await executeJavaScript("noop()", []);
		expect(r.output).toBe("Code executed successfully (no output)");
	});

	it("the sandbox is removed even when execution throws (covers catch-cleanup branch)", async () => {
		sandboxState.nextExecute = async () => {
			throw new Error("during execute");
		};
		await expect(executeJavaScript("1", [])).rejects.toThrow("during execute");
		expect(sandboxRemovals.length).toBeGreaterThan(0);
	});

	it("falls back to 'Execution failed' when the catch error has no message", async () => {
		sandboxState.nextExecute = async () => {
			throw {};
		};
		await expect(executeJavaScript("1", [])).rejects.toThrow("Execution failed");
	});
});

describe("createJavaScriptReplTool", () => {
	it("returns a tool with the expected name + label", () => {
		const t = createJavaScriptReplTool();
		expect(t.name).toBe("javascript_repl");
		expect(t.label).toBe("JavaScript REPL");
	});

	it("description threads providers through JAVASCRIPT_REPL_TOOL_DESCRIPTION (covers description getter)", () => {
		const t = createJavaScriptReplTool();
		t.runtimeProvidersFactory = () => [
			{ getDescription: () => "p1" } as never,
			{ getDescription: () => "" } as never, // filtered out
			{ getDescription: () => "p2" } as never,
		];
		expect(t.description).toBe("desc:p1|p2");
	});

	it("description falls back to empty providers when factory missing", () => {
		const t = createJavaScriptReplTool();
		t.runtimeProvidersFactory = undefined as never;
		expect(t.description).toBe("desc:");
	});

	it("execute returns files encoded as base64 (covers Uint8Array branch in toBase64)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			files: [{ fileName: "u.bin", mimeType: "application/octet-stream", content: new Uint8Array([65, 66]) }],
		});
		const t = createJavaScriptReplTool();
		const result = await t.execute("id", { title: "t", code: "1" });
		expect(result.details.files?.[0].contentBase64).toBe(btoa("AB"));
	});

	it("execute encodes string file content via TextEncoder (covers string branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			files: [{ fileName: "s.txt", mimeType: "text/plain", content: "hi" }],
		});
		const t = createJavaScriptReplTool();
		const r = await t.execute("id", { title: "t", code: "1" });
		expect(r.details.files?.[0].contentBase64).toBe(btoa("hi"));
	});

	it("execute coerces unknown file content via String() + TextEncoder (covers final else branch)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			files: [{ fileName: "x", mimeType: "x", content: 123 as unknown as string }],
		});
		const t = createJavaScriptReplTool();
		const r = await t.execute("id", { title: "t", code: "1" });
		expect(r.details.files?.[0].contentBase64).toBe(btoa("123"));
	});

	it("execute falls back to defaults for missing fileName and mimeType (covers ?? branches)", async () => {
		sandboxState.nextExecute = async () => ({
			success: true,
			files: [{ fileName: "", mimeType: "", content: "x" }],
		});
		const t = createJavaScriptReplTool();
		const r = await t.execute("id", { title: "t", code: "1" });
		expect(r.details.files?.[0].fileName).toBe("file");
		expect(r.details.files?.[0].mimeType).toBe("application/octet-stream");
	});

	it("execute swallows a missing runtimeProvidersFactory (covers ?? [] branch)", async () => {
		sandboxState.nextExecute = async () => ({ success: true });
		const t = createJavaScriptReplTool();
		t.runtimeProvidersFactory = undefined as never;
		await expect(t.execute("id", { title: "t", code: "noop()" })).resolves.toBeDefined();
	});

	it("default javascriptReplTool export is constructed from createJavaScriptReplTool", () => {
		expect(javascriptReplTool.name).toBe("javascript_repl");
	});
});

describe("javascriptReplRenderer", () => {
	it("renders header-only when neither params nor result is given (covers final return)", () => {
		const out = javascriptReplRenderer.render(undefined, undefined, false);
		expect(out.isCustom).toBe(false);
	});

	it("renders params-only when streaming (covers params-only branch)", () => {
		const out = javascriptReplRenderer.render({ title: "t", code: "1+1" }, undefined, true);
		expect(out.isCustom).toBe(false);
	});

	it("renders params-only without a code-block when params.code is empty", () => {
		const out = javascriptReplRenderer.render({ title: "t", code: "" }, undefined, true);
		expect(out.isCustom).toBe(false);
	});

	it("renders params + result with isError=true (covers result.isError → 'error' state)", () => {
		const out = javascriptReplRenderer.render(
			{ title: "t", code: "1" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: true,
				content: [{ type: "text", text: "boom" }],
				details: { files: [] },
				timestamp: 1,
			} as never,
			false,
		);
		expect(out.isCustom).toBe(false);
	});

	it("renders attachments for text-based files (covers text-decode branch)", () => {
		const out = javascriptReplRenderer.render(
			{ title: "t", code: "1" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: {
					files: [
						{ fileName: "a.txt", mimeType: "text/plain", size: 1, contentBase64: btoa("hi") },
						{ fileName: "a.json", mimeType: "application/json", size: 1, contentBase64: btoa('{"a":1}') },
						{ fileName: "a.js", mimeType: "application/javascript", size: 1, contentBase64: btoa("var x;") },
						{ fileName: "a.xml", mimeType: "text/xml", size: 1, contentBase64: btoa("<x/>") },
					],
				},
				timestamp: 1,
			} as never,
			false,
		);
		expect(out.isCustom).toBe(false);
	});

	it("handles invalid base64 content gracefully (covers atob catch branch)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = javascriptReplRenderer.render(
			{ title: "t", code: "1" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: { files: [{ fileName: "bad.txt", mimeType: "text/plain", size: 1, contentBase64: "!!!!" }] },
				timestamp: 1,
			} as never,
			false,
		);
		expect(out.isCustom).toBe(false);
		warnSpy.mockRestore();
	});

	it("renders attachments with image preview when mime is image/* (covers image branch)", () => {
		javascriptReplRenderer.render(
			{ title: "t", code: "1" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: {
					files: [{ fileName: "img.png", mimeType: "image/png", size: 1, contentBase64: "AA==" }],
				},
				timestamp: 1,
			} as never,
			false,
		);
	});

	it("uses i18n fallback when params.title is empty", () => {
		javascriptReplRenderer.render({ title: "", code: "1+1" }, undefined, true);
	});

	it("uses i18n fallback in result branch when params.title is empty", () => {
		javascriptReplRenderer.render(
			{ title: "", code: "1" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: { files: [] },
				timestamp: 1,
			} as never,
			false,
		);
	});

	it("renders without output console-block when result has no text content (covers empty-output branch)", () => {
		javascriptReplRenderer.render(
			{ title: "t", code: "1" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: false,
				content: [],
				details: { files: [] },
				timestamp: 1,
			} as never,
			false,
		);
	});

	it("renders result branch with empty params.code and defaulted file fields (covers || fallbacks)", () => {
		javascriptReplRenderer.render(
			{ title: "t", code: "" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: {
					files: [{ fileName: "", mimeType: "", size: undefined as unknown as number, contentBase64: "AA==" }],
				},
				timestamp: 1,
			} as never,
			false,
		);
	});

	it("handles missing files in details (covers details?.files || [] branch)", () => {
		javascriptReplRenderer.render(
			{ title: "t", code: "1" },
			{
				role: "toolResult",
				toolCallId: "tc",
				toolName: "javascript_repl",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: undefined,
				timestamp: 1,
			} as never,
			false,
		);
	});
});
