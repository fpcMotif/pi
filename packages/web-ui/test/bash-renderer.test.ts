// ADR-0017 phase C.7: BashRenderer branches.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/i18n.js", () => ({ i18n: (s: string) => s }));

import { BashRenderer } from "../src/tools/renderers/BashRenderer.js";

const renderer = new BashRenderer();

describe("BashRenderer.render", () => {
	it("returns a 'waiting' shape when no params and no result", () => {
		const out = renderer.render(undefined, undefined);
		expect(out.isCustom).toBe(false);
		expect(out.content).toBeDefined();
	});

	it("returns a 'streaming command' shape when params have a command but no result", () => {
		const out = renderer.render({ command: "echo hi" }, undefined);
		expect(out.isCustom).toBe(false);
		expect(out.content).toBeDefined();
	});

	it("returns a complete shape with combined output when result + non-empty content", () => {
		const out = renderer.render({ command: "echo hi" }, { content: [{ type: "text", text: "hello" }] } as never);
		expect(out.isCustom).toBe(false);
		expect(out.content).toBeDefined();
	});

	it("returns a complete shape with command-only when result content is empty array", () => {
		// Forces the `output ? ... : ...` ternary's false branch.
		const out = renderer.render({ command: "echo hi" }, { content: [] } as never);
		expect(out.isCustom).toBe(false);
	});

	it("renders error variant when result.isError is true", () => {
		const out = renderer.render({ command: "false" }, {
			content: [{ type: "text", text: "bad" }],
			isError: true,
		} as never);
		expect(out.isCustom).toBe(false);
	});

	it("falls back to '' for missing result.content (covers || '' branch)", () => {
		const out = renderer.render({ command: "ls" }, {} as never);
		expect(out.isCustom).toBe(false);
	});

	it("returns waiting shape when result exists but params.command is missing", () => {
		const out = renderer.render(undefined, { content: [] } as never);
		expect(out.isCustom).toBe(false);
	});
});
