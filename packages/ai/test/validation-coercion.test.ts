import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

// validation.ts coerces plain (serialized) JSON Schemas with AJV-compatible
// rules before TypeBox validation. These tests target the structural coercion
// paths: nested objects, additionalProperties, arrays (tuple + uniform),
// and allOf/anyOf/oneOf composition.

function plainSchemaTool(parameters: unknown): Tool {
	return {
		name: "structured",
		description: "Structured tool",
		parameters: parameters as Tool["parameters"],
	};
}

function call(args: Record<string, unknown>): ToolCall {
	return {
		type: "toolCall",
		id: "tool-1",
		name: "structured",
		arguments: args,
	};
}

describe("validation deep JSON-schema coercion", () => {
	it("coerces nested object properties", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				nested: {
					type: "object",
					properties: {
						count: { type: "number" },
						flag: { type: "boolean" },
					},
				},
			},
		});
		expect(validateToolArguments(tool, call({ nested: { count: "7", flag: "true" } }))).toEqual({
			nested: { count: 7, flag: true },
		});
	});

	it("skips object properties that are absent from the arguments", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				present: { type: "number" },
				absent: { type: "number" },
			},
		});
		expect(validateToolArguments(tool, call({ present: "5" }))).toEqual({ present: 5 });
	});

	it("coerces additionalProperties values that are not in the declared property set", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				known: { type: "string" },
			},
			additionalProperties: { type: "number" },
		});
		expect(validateToolArguments(tool, call({ known: 1, extra: "42", another: "100" }))).toEqual({
			known: "1",
			extra: 42,
			another: 100,
		});
	});

	it("coerces tuple-style array items by index", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				pair: {
					type: "array",
					items: [{ type: "number" }, { type: "boolean" }],
				},
			},
		});
		expect(validateToolArguments(tool, call({ pair: ["3", "false"] }))).toEqual({ pair: [3, false] });
	});

	it("ignores tuple positions beyond the declared item schemas", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				values: {
					type: "array",
					items: [{ type: "number" }],
				},
			},
		});
		// Index 1 has no schema, so it is left untouched.
		expect(validateToolArguments(tool, call({ values: ["9", "raw"] }))).toEqual({ values: [9, "raw"] });
	});

	it("coerces uniform array items with a single item schema", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				numbers: {
					type: "array",
					items: { type: "number" },
				},
			},
		});
		expect(validateToolArguments(tool, call({ numbers: ["1", "2", "3"] }))).toEqual({ numbers: [1, 2, 3] });
	});

	it("applies allOf schemas in sequence", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				value: {
					allOf: [{ type: "number" }],
				},
			},
		});
		expect(validateToolArguments(tool, call({ value: "12" }))).toEqual({ value: 12 });
	});

	it("coerces using the first matching anyOf member", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				value: {
					anyOf: [{ type: "boolean" }, { type: "number" }],
				},
			},
		});
		// "1" is not a valid boolean but coerces to the number 1.
		expect(validateToolArguments(tool, call({ value: "1" }))).toEqual({ value: 1 });
	});

	it("coerces using a matching oneOf member", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				value: {
					oneOf: [{ type: "number" }, { type: "string" }],
				},
			},
		});
		// "55" matches the string branch as-is, but coerceWithJsonSchema picks
		// the first oneOf member it can produce a valid coercion for — the
		// number branch — so the result is the numeric form.
		expect(validateToolArguments(tool, call({ value: "55" }))).toEqual({ value: 55 });
	});

	it("leaves the value unchanged when no union member can validate the coercion", () => {
		const tool = plainSchemaTool({
			type: "object",
			properties: {
				value: {
					anyOf: [{ type: "number" }, { type: "boolean" }],
				},
			},
		});
		// An object matches neither number nor boolean; coercion returns it as-is
		// and TypeBox validation then rejects it.
		expect(() => validateToolArguments(tool, call({ value: { unexpected: true } }))).toThrow("Validation failed");
	});

	it("returns the coerced top-level primitive when it validates", () => {
		// A top-level (non-object) plain schema: arguments are the primitive itself.
		const tool = plainSchemaTool({ type: "number" });
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "structured",
			arguments: "42" as unknown as Record<string, unknown>,
		};
		expect(validateToolArguments(tool, toolCall)).toBe(42);
	});

	it("falls back to the original arguments when a coerced top-level primitive fails validation", () => {
		const tool = plainSchemaTool({ type: "number" });
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "structured",
			// "abc" cannot coerce to a finite number, stays a string, fails number validation.
			arguments: "abc" as unknown as Record<string, unknown>,
		};
		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});
});
