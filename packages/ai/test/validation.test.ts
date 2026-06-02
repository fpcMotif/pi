import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { validateToolArguments, validateToolCall } from "../src/utils/validation.js";

function serializedPlainSchema(schema: Record<string, unknown>): Tool["parameters"] {
	return JSON.parse(JSON.stringify(schema)) as Tool["parameters"];
}

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: serializedPlainSchema({
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		}),
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: serializedPlainSchema({ type: "number" }), input: "42", expected: 42 },
			{ schema: serializedPlainSchema({ type: "number" }), input: true, expected: 1 },
			{ schema: serializedPlainSchema({ type: "number" }), input: false, expected: 0 },
			{ schema: serializedPlainSchema({ type: "number" }), input: null, expected: 0 },
			{ schema: serializedPlainSchema({ type: "integer" }), input: "42", expected: 42 },
			{ schema: serializedPlainSchema({ type: "integer" }), input: null, expected: 0 },
			{ schema: serializedPlainSchema({ type: "integer" }), input: true, expected: 1 },
			{ schema: serializedPlainSchema({ type: "integer" }), input: false, expected: 0 },
			{ schema: serializedPlainSchema({ type: "boolean" }), input: null, expected: false },
			{ schema: serializedPlainSchema({ type: "boolean" }), input: "true", expected: true },
			{ schema: serializedPlainSchema({ type: "boolean" }), input: "false", expected: false },
			{ schema: serializedPlainSchema({ type: "boolean" }), input: 1, expected: true },
			{ schema: serializedPlainSchema({ type: "boolean" }), input: 0, expected: false },
			{ schema: serializedPlainSchema({ type: "string" }), input: null, expected: "" },
			{ schema: serializedPlainSchema({ type: "string" }), input: true, expected: "true" },
			{ schema: serializedPlainSchema({ type: "null" }), input: "", expected: null },
			{ schema: serializedPlainSchema({ type: "null" }), input: 0, expected: null },
			{ schema: serializedPlainSchema({ type: "null" }), input: false, expected: null },
			{
				schema: serializedPlainSchema({ type: ["number", "string"] }),
				input: "1",
				expected: "1",
			},
			{
				schema: serializedPlainSchema({ type: ["boolean", "number"] }),
				input: "1",
				expected: 1,
			},
			{
				schema: serializedPlainSchema({ type: ["integer", "string"] }),
				input: 2,
				expected: 2,
			},
			{
				schema: serializedPlainSchema({ type: ["null", "string"] }),
				input: null,
				expected: null,
			},
			{
				schema: serializedPlainSchema({ type: ["array", "string"] }),
				input: [],
				expected: [],
			},
			{
				schema: serializedPlainSchema({ type: ["object", "string"] }),
				input: {},
				expected: {},
			},
			{
				schema: serializedPlainSchema({ type: ["mystery", "number"] }),
				input: "5",
				expected: 5,
			},
			{
				schema: serializedPlainSchema({ anyOf: [false, { type: "integer" }] }),
				input: "7",
				expected: 7,
			},
			{
				schema: serializedPlainSchema({
					anyOf: [{ type: "object", properties: { broken: false } }, { type: "string" }],
				}),
				input: "fallback",
				expected: "fallback",
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: serializedPlainSchema({ type: "boolean" }), input: "1" },
			{ schema: serializedPlainSchema({ type: "boolean" }), input: "0" },
			{ schema: serializedPlainSchema({ type: "null" }), input: "null" },
			{ schema: serializedPlainSchema({ type: "integer" }), input: "42.1" },
			{ schema: serializedPlainSchema({ type: "number" }), input: "" },
			{ schema: serializedPlainSchema({ type: "boolean" }), input: 2 },
			{ schema: serializedPlainSchema({ type: "string" }), input: {} },
			{ schema: serializedPlainSchema({ anyOf: [{ type: "integer" }, { type: "boolean" }] }), input: "nope" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});

	it("coerces nested objects, arrays, tuples, unions, and additional properties in plain schemas", () => {
		const tool: Tool = {
			name: "configure",
			description: "Configure a task",
			parameters: serializedPlainSchema({
				type: "object",
				properties: {
					count: { type: "integer" },
					flags: { type: "array", items: { type: "boolean" } },
					tuple: {
						type: "array",
						items: [{ type: "number" }, { type: "string" }],
					},
					unionValue: {
						anyOf: [{ type: "integer" }, { type: "string" }],
					},
					oneOfValue: {
						oneOf: [{ type: "boolean" }, { type: "string" }],
					},
					nested: {
						allOf: [
							{
								type: "object",
								properties: {
									enabled: { type: "boolean" },
								},
							},
							{
								type: "object",
								properties: {
									limit: { type: "number" },
								},
							},
						],
						type: "object",
						properties: {
							enabled: { type: "boolean" },
							limit: { type: "number" },
						},
					},
				},
				additionalProperties: { type: "number" },
				required: ["count", "flags", "tuple", "unionValue", "oneOfValue", "nested"],
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "configure",
			arguments: {
				count: "7",
				flags: ["true", 0, false],
				tuple: ["3.5", 9, "unchanged"],
				unionValue: "12",
				oneOfValue: "false",
				nested: {
					enabled: "true",
					limit: "4.25",
				},
				extra: "99",
			},
		};

		expect(validateToolCall([tool], toolCall)).toEqual({
			count: 7,
			flags: [true, false, false],
			tuple: [3.5, "9", "unchanged"],
			unionValue: 12,
			oneOfValue: false,
			nested: {
				enabled: true,
				limit: 4.25,
			},
			extra: 99,
		});
	});

	it("reports missing tools and nested required paths without mutating original arguments", () => {
		const tool: Tool = {
			name: "create",
			description: "Create a thing",
			parameters: Type.Object({
				nested: Type.Object({
					requiredValue: Type.String(),
				}),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "create",
			arguments: { nested: {} },
		};

		expect(() => validateToolCall([], toolCall)).toThrow('Tool "create" not found');
		expect(() => validateToolArguments(tool, toolCall)).toThrow("nested.requiredValue");
		expect(toolCall.arguments).toEqual({ nested: {} });
	});

	it("reuses cached validators and supports primitive root coercion for plain schemas", () => {
		const numberTool: Tool = {
			name: "number",
			description: "Number root",
			parameters: serializedPlainSchema({ type: "number" }),
		};
		const numberCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "number",
			arguments: "42" as unknown as ToolCall["arguments"],
		};

		expect(validateToolArguments(numberTool, numberCall)).toBe(42);
		expect(validateToolArguments(numberTool, numberCall)).toBe(42);

		const rootRequiredTool: Tool = {
			name: "root",
			description: "Root required",
			parameters: Type.Object({ requiredValue: Type.String() }),
		};
		const rootCall: ToolCall = {
			type: "toolCall",
			id: "tool-2",
			name: "root",
			arguments: {},
		};
		expect(() => validateToolArguments(rootRequiredTool, rootCall)).toThrow("requiredValue");

		const rootNumberTool: Tool = {
			name: "root-number",
			description: "Root number",
			parameters: Type.Number(),
		};
		const rootNumberCall: ToolCall = {
			type: "toolCall",
			id: "tool-3",
			name: "root-number",
			arguments: "nope" as unknown as ToolCall["arguments"],
		};
		expect(() => validateToolArguments(rootNumberTool, rootNumberCall)).toThrow("root");
	});

	it("keeps primitive root arguments when coercion fails schema constraints", () => {
		const minimumTool: Tool = {
			name: "minimum",
			description: "Minimum number",
			parameters: serializedPlainSchema({ type: "number", minimum: 10 }),
		};
		const minimumCall: ToolCall = {
			type: "toolCall",
			id: "tool-4",
			name: "minimum",
			arguments: "5" as unknown as ToolCall["arguments"],
		};

		expect(validateToolArguments(minimumTool, minimumCall)).toBe("5");
	});

	it("replaces object arguments when a top-level union returns a coerced clone", () => {
		const tool: Tool = {
			name: "union-object",
			description: "Union object",
			parameters: serializedPlainSchema({
				anyOf: [
					{
						type: "object",
						properties: { count: { type: "number" } },
						required: ["count"],
					},
				],
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-5",
			name: "union-object",
			arguments: { count: "5", stale: "remove me" },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ count: 5, stale: "remove me" });
	});

	it("skips malformed plain union branches instead of failing coercion", () => {
		let requiredReads = 0;
		const malformedBranch = {
			type: "object",
			properties: {
				value: { type: "number" },
			},
			get required(): string[] {
				requiredReads++;
				if (requiredReads === 9) {
					throw new Error("bad schema");
				}
				return ["value"];
			},
		};
		const tool: Tool = {
			name: "union-object",
			description: "Union object",
			parameters: {
				anyOf: [
					malformedBranch,
					{
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				],
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-6",
			name: "union-object",
			arguments: { value: "fallback" },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: "fallback" });
	});
});
