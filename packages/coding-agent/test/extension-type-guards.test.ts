import { describe, expect, it } from "vitest";
import {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
	type ToolCallEvent,
	type ToolResultEvent,
} from "../src/core/extensions/types.js";

function makeResultEvent(toolName: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName,
		toolCallId: "tc_1",
		input: {},
		result: undefined,
		details: undefined,
		isError: false,
		duration: 0,
	} as unknown as ToolResultEvent;
}

function makeCallEvent(toolName: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolName,
		toolCallId: "tc_1",
		input: {},
	} as unknown as ToolCallEvent;
}

describe("tool result type guards", () => {
	it("isBashToolResult narrows by name", () => {
		expect(isBashToolResult(makeResultEvent("bash"))).toBe(true);
		expect(isBashToolResult(makeResultEvent("read"))).toBe(false);
	});

	it("isReadToolResult narrows by name", () => {
		expect(isReadToolResult(makeResultEvent("read"))).toBe(true);
		expect(isReadToolResult(makeResultEvent("bash"))).toBe(false);
	});

	it("isEditToolResult narrows by name", () => {
		expect(isEditToolResult(makeResultEvent("edit"))).toBe(true);
		expect(isEditToolResult(makeResultEvent("write"))).toBe(false);
	});

	it("isWriteToolResult narrows by name", () => {
		expect(isWriteToolResult(makeResultEvent("write"))).toBe(true);
		expect(isWriteToolResult(makeResultEvent("edit"))).toBe(false);
	});

	it("isGrepToolResult narrows by name", () => {
		expect(isGrepToolResult(makeResultEvent("grep"))).toBe(true);
		expect(isGrepToolResult(makeResultEvent("find"))).toBe(false);
	});

	it("isFindToolResult narrows by name", () => {
		expect(isFindToolResult(makeResultEvent("find"))).toBe(true);
		expect(isFindToolResult(makeResultEvent("grep"))).toBe(false);
	});

	it("isLsToolResult narrows by name", () => {
		expect(isLsToolResult(makeResultEvent("ls"))).toBe(true);
		expect(isLsToolResult(makeResultEvent("bash"))).toBe(false);
	});
});

describe("isToolCallEventType", () => {
	it("returns true when toolName matches", () => {
		expect(isToolCallEventType("bash", makeCallEvent("bash"))).toBe(true);
		expect(isToolCallEventType("read", makeCallEvent("read"))).toBe(true);
		expect(isToolCallEventType("edit", makeCallEvent("edit"))).toBe(true);
		expect(isToolCallEventType("write", makeCallEvent("write"))).toBe(true);
		expect(isToolCallEventType("grep", makeCallEvent("grep"))).toBe(true);
		expect(isToolCallEventType("find", makeCallEvent("find"))).toBe(true);
		expect(isToolCallEventType("ls", makeCallEvent("ls"))).toBe(true);
	});

	it("returns false when toolName does not match", () => {
		expect(isToolCallEventType("bash", makeCallEvent("read"))).toBe(false);
	});

	it("works with custom tool name", () => {
		expect(isToolCallEventType("my_custom", makeCallEvent("my_custom"))).toBe(true);
		expect(isToolCallEventType("my_custom", makeCallEvent("bash"))).toBe(false);
	});
});

describe("defineTool", () => {
	it("returns the tool definition unchanged", () => {
		const tool = {
			name: "test",
			description: "test tool",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({ result: "ok" }),
		} as never;
		const result = defineTool(tool);
		expect(result).toBe(tool);
	});
});
