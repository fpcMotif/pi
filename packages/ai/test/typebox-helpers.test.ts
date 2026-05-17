import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { StringEnum } from "../src/utils/typebox-helpers.js";

// TypeBox stores schema metadata (type, enum, description, default) on the
// runtime object but the public `TUnsafe<…>` static type does not expose them;
// reach through this shape for the value-level assertions.
type StringEnumSchemaShape = {
	type: string;
	enum: ReadonlyArray<string>;
	description?: string;
	default?: string;
};

describe("StringEnum", () => {
	it("builds a string schema with the provided enum values", () => {
		const schema = StringEnum(["add", "subtract"]) as unknown as StringEnumSchemaShape;

		expect(schema.type).toBe("string");
		expect(schema.enum).toEqual(["add", "subtract"]);
		expect(schema.description).toBeUndefined();
		expect(schema.default).toBeUndefined();
	});

	it("includes description and default when supplied", () => {
		const schema = StringEnum(["add", "subtract", "multiply"], {
			description: "operation",
			default: "add",
		}) as unknown as StringEnumSchemaShape;

		expect(schema.description).toBe("operation");
		expect(schema.default).toBe("add");
	});

	it("validates only values present in the enum", () => {
		const schema = StringEnum(["red", "green", "blue"]);

		expect(Value.Check(schema, "green")).toBe(true);
		expect(Value.Check(schema, "purple")).toBe(false);
		expect(Value.Check(schema, 1)).toBe(false);
	});
});
