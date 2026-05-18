// ADR-0017 phase C.7: cover tools/index.ts (renderTool + setShowJsonMode).
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));
// Auto-register modules pulled in by tools/index.ts have heavy side effects;
// mock them to no-op so tests stay isolated.
vi.mock("../src/tools/javascript-repl.js", () => ({}));
vi.mock("../src/tools/extract-document.js", () => ({}));

import { registerToolRenderer, renderTool, setShowJsonMode } from "../src/tools/index.js";

describe("tools/index renderTool dispatch", () => {
	it("uses the registered renderer when one exists for the tool name", () => {
		const customRenderer = {
			render: vi.fn(() => ({ content: "CUSTOM" as never, isCustom: true })),
		};
		registerToolRenderer("MyTool", customRenderer as never);
		const out = renderTool("MyTool", { p: 1 }, undefined);
		expect(out.isCustom).toBe(true);
		expect(customRenderer.render).toHaveBeenCalledWith({ p: 1 }, undefined, undefined);
	});

	it("falls back to DefaultRenderer when no renderer is registered for the name", () => {
		const out = renderTool("never-registered-tool", { x: 1 }, undefined);
		expect(out.isCustom).toBe(false);
	});

	it("setShowJsonMode(true) forces DefaultRenderer for every tool", () => {
		const customRenderer = {
			render: vi.fn(() => ({ content: "CUSTOM" as never, isCustom: true })),
		};
		registerToolRenderer("Forced", customRenderer as never);

		setShowJsonMode(true);
		const out = renderTool("Forced", { p: 1 }, undefined);
		// In show-json mode, the custom renderer is bypassed → isCustom is false (default).
		expect(out.isCustom).toBe(false);
		expect(customRenderer.render).not.toHaveBeenCalled();
		setShowJsonMode(false); // restore for sibling tests
	});

	it("setShowJsonMode(false) re-enables the registered renderer", () => {
		const customRenderer = {
			render: vi.fn(() => ({ content: "CUSTOM" as never, isCustom: true })),
		};
		registerToolRenderer("Toggle", customRenderer as never);

		setShowJsonMode(true);
		renderTool("Toggle", { p: 1 }, undefined);
		expect(customRenderer.render).not.toHaveBeenCalled();

		setShowJsonMode(false);
		renderTool("Toggle", { p: 2 }, undefined);
		expect(customRenderer.render).toHaveBeenCalledOnce();
	});

	it("passes isStreaming through to the renderer", () => {
		const renderer = { render: vi.fn(() => ({ content: "x" as never, isCustom: true })) };
		registerToolRenderer("StreamCheck", renderer as never);
		renderTool("StreamCheck", { x: 1 }, undefined, true);
		expect(renderer.render).toHaveBeenCalledWith({ x: 1 }, undefined, true);
	});
});
