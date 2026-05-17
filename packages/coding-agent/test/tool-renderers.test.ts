import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import {
	bashToolRenderer,
	createBuiltinToolRendererRegistry,
	editToolRenderer,
	findToolRenderer,
	grepToolRenderer,
	lsToolRenderer,
	readToolRenderer,
	writeToolRenderer,
} from "../src/modes/interactive/tool-renderers/index.js";

function fakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

beforeAll(() => {
	initTheme("dark");
});

describe("tool-renderer registry", () => {
	test("BUILTIN_TOOL_RENDERERS exposes all 7 tools", () => {
		const registry = createBuiltinToolRendererRegistry();
		expect(registry.has("read")).toBe(true);
		expect(registry.has("bash")).toBe(true);
		expect(registry.has("edit")).toBe(true);
		expect(registry.has("write")).toBe(true);
		expect(registry.has("grep")).toBe(true);
		expect(registry.has("find")).toBe(true);
		expect(registry.has("ls")).toBe(true);
	});

	test("each renderer exports both renderCall and renderResult", () => {
		expect(typeof bashToolRenderer.renderCall).toBe("function");
		expect(typeof bashToolRenderer.renderResult).toBe("function");
		expect(typeof readToolRenderer.renderCall).toBe("function");
		expect(typeof readToolRenderer.renderResult).toBe("function");
		expect(typeof editToolRenderer.renderCall).toBe("function");
		expect(typeof editToolRenderer.renderResult).toBe("function");
		expect(typeof writeToolRenderer.renderCall).toBe("function");
		expect(typeof writeToolRenderer.renderResult).toBe("function");
		expect(typeof grepToolRenderer.renderCall).toBe("function");
		expect(typeof grepToolRenderer.renderResult).toBe("function");
		expect(typeof findToolRenderer.renderCall).toBe("function");
		expect(typeof findToolRenderer.renderResult).toBe("function");
		expect(typeof lsToolRenderer.renderCall).toBe("function");
		expect(typeof lsToolRenderer.renderResult).toBe("function");
	});
});

describe("bash tool renderer", () => {
	test("renders bash call with command", () => {
		const c = new ToolExecutionComponent(
			"bash",
			"id-1",
			{ command: "echo hi" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("echo hi");
	});

	test("renders bash call with timeout suffix", () => {
		const c = new ToolExecutionComponent(
			"bash",
			"id-2",
			{ command: "sleep 1", timeout: 30 },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("timeout 30s");
	});

	test("renders bash result with stdout", () => {
		const c = new ToolExecutionComponent(
			"bash",
			"id-3",
			{ command: "echo hi" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		c.updateResult({ content: [{ type: "text", text: "hi\nthere" }], details: undefined, isError: false }, false);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("hi");
		expect(out).toContain("there");
	});

	test("renders bash result with truncation", () => {
		const c = new ToolExecutionComponent("bash", "id-4", { command: "x" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult(
			{
				content: [{ type: "text", text: "out" }],
				details: { truncation: { truncated: true, outputLines: 5, totalLines: 100, truncatedBy: "lines" } },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("Truncated");
	});

	test("renders bash result with fullOutputPath", () => {
		const c = new ToolExecutionComponent("bash", "id-5", { command: "x" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult(
			{
				content: [{ type: "text", text: "out" }],
				details: { fullOutputPath: "/tmp/full.txt" },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("Full output");
		expect(out).toContain("/tmp/full.txt");
	});

	test("renders bash result with size-based truncation", () => {
		const c = new ToolExecutionComponent("bash", "id-6", { command: "x" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult(
			{
				content: [{ type: "text", text: "out" }],
				details: { truncation: { truncated: true, outputLines: 5, maxBytes: 1024, truncatedBy: "bytes" } },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("Truncated");
	});

	test("renders empty command as placeholder", () => {
		const c = new ToolExecutionComponent("bash", "id-7", { command: "" }, {}, undefined, fakeTui(), process.cwd());
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("...");
	});

	test("renders invalid command (not a string) as invalid-arg marker", () => {
		const c = new ToolExecutionComponent("bash", "id-8", { command: 123 }, {}, undefined, fakeTui(), process.cwd());
		const out = stripAnsi(c.render(120).join("\n"));
		// Invalid arg renderer produces some marker text
		expect(out.length).toBeGreaterThan(0);
	});
});

describe("read tool renderer", () => {
	test("renders read call with path", () => {
		const c = new ToolExecutionComponent(
			"read",
			"r-1",
			{ path: "/test/file.ts" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("read");
		expect(out).toContain("file.ts");
	});

	test("renders read result with content", () => {
		const c = new ToolExecutionComponent("read", "r-2", { path: "f.ts" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult({ content: [{ type: "text", text: "line1\nline2" }], details: undefined, isError: false }, false);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("line");
	});
});

describe("find tool renderer", () => {
	test("renders find call with pattern", () => {
		const c = new ToolExecutionComponent(
			"find",
			"f-1",
			{ pattern: "*.ts", path: "src" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("find");
		expect(out).toContain("*.ts");
	});

	test("renders find call with limit", () => {
		const c = new ToolExecutionComponent(
			"find",
			"f-2",
			{ pattern: "*.ts", path: ".", limit: 100 },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("limit");
		expect(out).toContain("100");
	});

	test("renders find result with content", () => {
		const c = new ToolExecutionComponent(
			"find",
			"f-3",
			{ pattern: "*", path: "." },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		c.updateResult(
			{ content: [{ type: "text", text: "src/file1.ts\nsrc/file2.ts" }], details: undefined, isError: false },
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("file1.ts");
	});

	test("renders find result with resultLimitReached warning", () => {
		const c = new ToolExecutionComponent("find", "f-4", { pattern: "*" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult(
			{
				content: [{ type: "text", text: "file1.ts" }],
				details: { resultLimitReached: 1000 },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("Truncated");
	});

	test("renders find result with byte truncation warning", () => {
		const c = new ToolExecutionComponent("find", "f-5", { pattern: "*" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult(
			{
				content: [{ type: "text", text: "file" }],
				details: { truncation: { truncated: true, maxBytes: 1024 } },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("Truncated");
	});

	test("renders find result with many lines and expand hint", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `file${i}.ts`).join("\n");
		const c = new ToolExecutionComponent("find", "f-6", { pattern: "*" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult({ content: [{ type: "text", text: lines }], details: undefined, isError: false }, false);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("more lines");
	});
});

describe("grep tool renderer", () => {
	test("renders grep call with pattern", () => {
		const c = new ToolExecutionComponent(
			"grep",
			"g-1",
			{ pattern: "TODO", path: "src" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("grep");
		expect(out).toContain("TODO");
	});

	test("renders grep result with hits", () => {
		const c = new ToolExecutionComponent("grep", "g-2", { pattern: "test" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult(
			{ content: [{ type: "text", text: "file.ts:10: test()" }], details: undefined, isError: false },
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("file.ts");
	});
});

describe("ls tool renderer", () => {
	test("renders ls call with path", () => {
		const c = new ToolExecutionComponent("ls", "l-1", { path: "src" }, {}, undefined, fakeTui(), process.cwd());
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("ls");
	});

	test("renders ls result with files", () => {
		const c = new ToolExecutionComponent("ls", "l-2", { path: "." }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult(
			{ content: [{ type: "text", text: "file.ts\nsubdir/" }], details: undefined, isError: false },
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("file.ts");
	});
});

describe("write tool renderer", () => {
	test("renders write call with path", () => {
		const c = new ToolExecutionComponent(
			"write",
			"w-1",
			{ path: "new.ts", content: "x" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("write");
		expect(out).toContain("new.ts");
	});

	test("renders write result success", () => {
		const c = new ToolExecutionComponent(
			"write",
			"w-2",
			{ path: "f.ts", content: "x" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		c.updateResult({ content: [{ type: "text", text: "written" }], details: undefined, isError: false }, false);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out.length).toBeGreaterThan(0);
	});
});

describe("edit tool renderer", () => {
	test("renders edit call with path", () => {
		const c = new ToolExecutionComponent(
			"edit",
			"e-1",
			{ path: "f.ts", oldText: "a", newText: "b" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("edit");
	});

	test("renders edit result with diff", () => {
		const c = new ToolExecutionComponent(
			"edit",
			"e-2",
			{ path: "f.ts", oldText: "a", newText: "b" },
			{},
			undefined,
			fakeTui(),
			process.cwd(),
		);
		c.updateResult(
			{
				content: [{ type: "text", text: "updated" }],
				details: { diff: "@@ -1 +1 @@\n-a\n+b\n", firstChangedLine: 1 },
				isError: false,
			},
			false,
		);
		const out = stripAnsi(c.render(120).join("\n"));
		expect(out).toContain("edit");
	});
});
