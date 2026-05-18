// ADR-0017 coverage push: ArtifactsToolRenderer.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
vi.mock("lucide", () => ({ FileCode2: {} }));
vi.mock("@mariozechner/mini-lit/dist/Diff.js", () => ({ Diff: () => "[diff]" }));
vi.mock("@mariozechner/mini-lit/dist/CodeBlock.js", () => ({}));
vi.mock("../src/components/ConsoleBlock.js", () => ({}));
vi.mock("../src/tools/renderer-registry.js", () => ({
	renderCollapsibleHeader: () => "[collapsible-header]",
	renderHeader: () => "[header]",
}));

const { ArtifactPillMock } = vi.hoisted(() => ({ ArtifactPillMock: vi.fn(() => "[pill]") }));
vi.mock("../src/tools/artifacts/ArtifactPill.js", () => ({
	ArtifactPill: (...args: unknown[]) => ArtifactPillMock(...args),
}));

import { ArtifactsToolRenderer } from "../src/tools/artifacts/artifacts-tool-renderer.js";

const makeResult = (overrides: Partial<{ isError: boolean; content: Array<{ type: string; text?: string }> }> = {}) =>
	({
		role: "toolResult",
		toolCallId: "tc",
		toolName: "artifacts",
		isError: overrides.isError ?? false,
		content: overrides.content ?? [{ type: "text", text: "output text" }],
		timestamp: 1,
	}) as never;

describe("ArtifactsToolRenderer", () => {
	const r = new ArtifactsToolRenderer({} as never);

	it("returns the prepare header when no params and no result are given", () => {
		const out = r.render(undefined, undefined, false);
		expect(out.isCustom).toBe(false);
	});

	// ---- Params-only branches ----
	it("renders preparing-artifact header when params has no command", () => {
		r.render({} as never, undefined, true);
	});

	it("renders create command in streaming mode with content", () => {
		r.render({ command: "create", filename: "a.js", content: "x" } as never, undefined, true);
	});

	it("renders rewrite command in streaming mode without content (covers !content branch)", () => {
		r.render({ command: "rewrite", filename: "a.js" } as never, undefined, true);
	});

	it("renders update command with old_str/new_str diff (covers diff branch)", () => {
		r.render({ command: "update", filename: "a.js", old_str: "old", new_str: "new" } as never, undefined, true);
	});

	it("renders update command without diff inputs (covers !diff branch)", () => {
		r.render({ command: "update", filename: "a.js" } as never, undefined, true);
	});

	it("renders get command in streaming mode (covers get/logs branch)", () => {
		r.render({ command: "get", filename: "a.js" } as never, undefined, true);
	});

	it("renders logs command in streaming mode (covers get/logs branch)", () => {
		r.render({ command: "logs", filename: "a.js" } as never, undefined, true);
	});

	it("renders unknown command in streaming mode (covers default branch)", () => {
		r.render({ command: "delete", filename: "a.js" } as never, undefined, true);
	});

	it("renders unknown command label using the fallback labels (covers labels[command] || fallback)", () => {
		r.render({ command: "bogus-cmd", filename: "a.js" } as never, undefined, true);
	});

	// ---- Result + params branches ----
	it("renders get command result with file content (covers get success branch)", () => {
		r.render({ command: "get", filename: "a.json" } as never, makeResult(), false);
	});

	it("renders get command result with empty content (covers (no output) fallback)", () => {
		r.render({ command: "get", filename: "a.json" } as never, makeResult({ content: [] }), false);
	});

	it("renders logs command result with output (covers logs success branch)", () => {
		r.render({ command: "logs", filename: "a.html" } as never, makeResult(), false);
	});

	it("renders logs command result with empty logs (covers (no output) fallback)", () => {
		r.render({ command: "logs", filename: "a.html" } as never, makeResult({ content: [] }), false);
	});

	it("renders create command result with code block (covers create success branch)", () => {
		r.render({ command: "create", filename: "a.js", content: "var x = 1;" } as never, makeResult(), false);
	});

	it("renders create command result with html filename + logs (covers isHtml && logs branch)", () => {
		r.render({ command: "create", filename: "a.html", content: "<p/>" } as never, makeResult(), false);
	});

	it("renders rewrite command result with empty content (covers !codeContent branch)", () => {
		r.render({ command: "rewrite", filename: "a.js" } as never, makeResult({ content: [] }), false);
	});

	it("renders rewrite command result with html filename but no logs (covers !logs branch)", () => {
		r.render(
			{ command: "rewrite", filename: "a.html", content: "<p/>" } as never,
			makeResult({ content: [] }),
			false,
		);
	});

	it("renders update command result with diff (covers update success branch)", () => {
		r.render({ command: "update", filename: "a.js", old_str: "old", new_str: "new" } as never, makeResult(), false);
	});

	it("renders update command result for html with logs (covers isHtml && logs branch)", () => {
		r.render({ command: "update", filename: "a.html", old_str: "old", new_str: "new" } as never, makeResult(), false);
	});

	it("renders delete command result (covers final delete branch)", () => {
		r.render({ command: "delete", filename: "a.js" } as never, makeResult(), false);
	});

	it("renders result with no command (covers !command labels fallback in result branch)", () => {
		r.render({} as never, makeResult(), false);
	});

	// ---- Error branches ----
	it("renders create error with code block + diff suppressed (covers create error branch)", () => {
		r.render(
			{ command: "create", filename: "a.js", content: "x" } as never,
			makeResult({ isError: true, content: [{ type: "text", text: "boom" }] }),
			false,
		);
	});

	it("renders update error with diff (isDiff true, old_str + new_str defined)", () => {
		r.render(
			{ command: "update", filename: "a.html", old_str: "o", new_str: "n" } as never,
			makeResult({ isError: true, content: [{ type: "text", text: "boom" }] }),
			false,
		);
	});

	it("renders rewrite error without content (covers !content branch in error)", () => {
		r.render({ command: "rewrite", filename: "a.html" } as never, makeResult({ isError: true, content: [] }), false);
	});

	it("renders create error with non-html filename (covers !isHtml error branch)", () => {
		r.render(
			{ command: "create", filename: "a.css", content: "x" } as never,
			makeResult({ isError: true, content: [] }),
			false,
		);
	});

	it("renders 'other' command error (covers final non-create/update/rewrite error branch)", () => {
		r.render({ command: "delete", filename: "a.js" } as never, makeResult({ isError: true, content: [] }), false);
	});

	it("renders error with no command (covers !command labels fallback in error branch)", () => {
		r.render({} as never, makeResult({ isError: true, content: [] }), false);
	});

	it("renders error with no params (covers result-only error path)", () => {
		r.render(undefined as never, makeResult({ isError: true, content: [] }), false);
	});

	// Language map coverage — variety of extensions hit getLanguageFromFilename.
	it("derives language from extension across all branches in the language map", () => {
		const exts = [
			"js",
			"jsx",
			"ts",
			"tsx",
			"html",
			"css",
			"scss",
			"json",
			"py",
			"md",
			"svg",
			"xml",
			"yaml",
			"yml",
			"sh",
			"bash",
			"sql",
			"java",
			"c",
			"cpp",
			"cs",
			"go",
			"rs",
			"php",
			"rb",
			"swift",
			"kt",
			"r",
			"unknown-ext",
		];
		for (const ext of exts) {
			r.render({ command: "get", filename: `f.${ext}` } as never, makeResult(), false);
		}
	});

	it("derives 'text' language when filename has no extension (covers undefined-ext branch)", () => {
		r.render({ command: "get", filename: "no-ext" } as never, makeResult(), false);
	});

	it("derives 'text' language when filename is undefined (covers !filename branch)", () => {
		r.render({ command: "get" } as never, makeResult(), false);
	});

	it("derives 'text' language when filename ends in a dot (covers ext-empty branch)", () => {
		// "trailing.".split(".").pop() === "" — exercises the `ext || ""` falsy branch.
		r.render({ command: "get", filename: "trailing." } as never, makeResult(), false);
	});

	it("renders update result with empty content (covers `getTextOutput(result) || ''` empty branch)", () => {
		r.render(
			{ command: "update", filename: "a.js", old_str: "o", new_str: "n" } as never,
			makeResult({ content: [] }),
			false,
		);
	});

	it("renders update result with undefined old_str/new_str (covers `params.x || ''` empty branches)", () => {
		r.render({ command: "update", filename: "a.js" } as never, makeResult(), false);
	});

	it("renders update result without filename (covers `filename?.endsWith` optional-chain branch)", () => {
		r.render({ command: "update", old_str: "o", new_str: "n" } as never, makeResult(), false);
	});

	it("renderHeaderWithPill without filename uses the labelText-only span", () => {
		r.render({ command: "get" } as never, makeResult(), false);
	});

	it("constructor with no artifactsPanel works (covers default argument)", () => {
		const r2 = new ArtifactsToolRenderer();
		expect(r2.artifactsPanel).toBeUndefined();
	});
});
