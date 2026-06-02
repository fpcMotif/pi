import { describe, expect, it } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/utils/json-parse.js";

describe("JSON repair helpers", () => {
	it("escapes raw control characters inside strings while preserving valid escapes", () => {
		const repaired = repairJson('{"line":"one\ntwo","tab":"\\t","unicode":"\\u263a"}');
		const repairedControls = repairJson('{"backspace":"a\bb","formFeed":"a\fb","rawTab":"a\tb","nul":"a\0b"}');

		expect(repaired).toBe('{"line":"one\\ntwo","tab":"\\t","unicode":"\\u263a"}');
		expect(JSON.parse(repaired)).toEqual({
			line: "one\ntwo",
			tab: "\t",
			unicode: "\u263a",
		});
		expect(repairedControls).toBe('{"backspace":"a\\bb","formFeed":"a\\fb","rawTab":"a\\tb","nul":"a\\u0000b"}');
	});

	it("doubles invalid or dangling backslashes inside strings", () => {
		expect(repairJson('{"path":"C:\\dir\\q"}')).toBe('{"path":"C:\\\\dir\\\\q"}');
		expect(repairJson('{"path":"C:\\')).toBe('{"path":"C:\\\\');
		expect(repairJson('{"bad":"\\u12xz"}')).toBe('{"bad":"\\\\u12xz"}');
	});

	it("parses repaired JSON only when the repair changed the payload", () => {
		expect(parseJsonWithRepair<{ value: string }>('{"value":"a\rb"}')).toEqual({ value: "a\rb" });
		expect(() => parseJsonWithRepair("{")).toThrow();
	});

	it("returns an empty object for blank streaming chunks", () => {
		expect(parseStreamingJson(undefined)).toEqual({});
		expect(parseStreamingJson("   ")).toEqual({});
	});

	it("parses complete, partial, repaired partial, and unrecoverable streaming JSON", () => {
		expect(parseStreamingJson('{"a":1}')).toEqual({ a: 1 });
		expect(parseStreamingJson('{"a":')).toEqual({});
		expect(parseStreamingJson('{"a":"hello')).toEqual({ a: "hello" });
		expect(parseStreamingJson('{"a":"hello\\d"}')).toEqual({ a: "hello\\d" });
		expect(parseStreamingJson('{"a":"hello\\d')).toEqual({ a: "hello" });
		expect(parseStreamingJson("nul")).toEqual({});
		expect(parseStreamingJson("[")).toEqual([]);
		expect(parseStreamingJson("\\&b&&1\n@\\b]")).toEqual({});
	});
});
