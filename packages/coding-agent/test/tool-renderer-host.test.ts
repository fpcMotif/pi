import { describe, expect, it } from "vitest";
import { ToolRendererHost } from "../src/modes/interactive/tool-renderer-host.js";

describe("ToolRendererHost", () => {
	it("centralizes tool render state transitions behind snapshots", () => {
		const host = new ToolRendererHost({
			toolName: "read",
			toolCallId: "call-1",
			args: { path: "a.txt" },
			showImages: true,
			imageWidthCells: 60,
		});

		expect(host.snapshot).toMatchObject({
			toolName: "read",
			toolCallId: "call-1",
			executionStarted: false,
			argsComplete: false,
			isPartial: true,
		});

		host.markExecutionStarted();
		host.setArgsComplete();
		host.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		expect(host.snapshot).toMatchObject({
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			result: { isError: false },
		});
	});

	it("normalizes image width in the snapshot", () => {
		const host = new ToolRendererHost({
			toolName: "read",
			toolCallId: "call-1",
			args: {},
			showImages: true,
			imageWidthCells: 60,
		});

		host.setImageWidthCells(0.2);

		expect(host.snapshot.imageWidthCells).toBe(1);
	});
});
