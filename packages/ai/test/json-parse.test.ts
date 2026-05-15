import { describe, expect, it } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/utils/json-parse.js";

describe("repairJson", () => {
	it("leaves valid JSON untouched", () => {
		const input = '{"a":"b","c":[1,2,3]}';
		expect(repairJson(input)).toBe(input);
	});

	it("escapes raw control characters inside strings", () => {
		expect(repairJson('{"a":"line1\nline2"}')).toBe('{"a":"line1\\nline2"}');
		expect(repairJson('{"a":"tab\there"}')).toBe('{"a":"tab\\there"}');
		expect(repairJson('{"a":"return\rhere"}')).toBe('{"a":"return\\rhere"}');
		expect(repairJson('{"a":"back\bspace"}')).toBe('{"a":"back\\bspace"}');
		expect(repairJson('{"a":"form\ffeed"}')).toBe('{"a":"form\\ffeed"}');
	});

	it("escapes uncommon control characters with \\u sequences", () => {
		//  (start of heading) has no shorthand escape
		expect(repairJson('{"a":""}')).toBe('{"a":"\\u0001"}');
	});

	it("does not touch control characters outside of strings", () => {
		// raw newline between tokens is not inside a string literal
		expect(repairJson('{"a":1,\n"b":2}')).toBe('{"a":1,\n"b":2}');
	});

	it("preserves valid escape sequences", () => {
		const input = '{"a":"quote \\" slash \\/ newline \\n"}';
		expect(repairJson(input)).toBe(input);
	});

	it("preserves valid unicode escapes", () => {
		const input = '{"a":"\\u00e9"}';
		expect(repairJson(input)).toBe(input);
	});

	it("doubles backslashes before invalid escape characters", () => {
		// \x is not a valid JSON escape, so the backslash should be doubled
		expect(repairJson('{"a":"path\\xfoo"}')).toBe('{"a":"path\\\\xfoo"}');
	});

	it("doubles a trailing backslash at end of input", () => {
		expect(repairJson('{"a":"trailing\\')).toBe('{"a":"trailing\\\\');
	});

	it("keeps a truncated unicode escape as a single-char \\u escape", () => {
		// \u followed by too few hex digits fails the 4-hex-digit check, but "u" is
		// itself in the valid-escape set, so the \u is preserved verbatim (only the
		// "u" is consumed) rather than the backslash being doubled.
		expect(repairJson('{"a":"\\u12"}')).toBe('{"a":"\\u12"}');
	});

	it("doubles a backslash before a genuinely invalid escape that is also not 'u'", () => {
		// \z is not a valid escape and z does not begin a unicode escape.
		expect(repairJson('{"a":"\\z"}')).toBe('{"a":"\\\\z"}');
	});

	it("handles a string that closes correctly mid-document", () => {
		expect(repairJson('{"a":"done"}')).toBe('{"a":"done"}');
	});
});

describe("parseJsonWithRepair", () => {
	it("parses valid JSON directly", () => {
		expect(parseJsonWithRepair('{"x":1}')).toEqual({ x: 1 });
	});

	it("repairs and parses JSON with raw control characters", () => {
		expect(parseJsonWithRepair('{"x":"a\nb"}')).toEqual({ x: "a\nb" });
	});

	it("rethrows the original error when repair does not change the input", () => {
		// Structurally broken JSON that the string-literal repairer cannot fix
		expect(() => parseJsonWithRepair("{not json")).toThrow();
	});
});

describe("parseStreamingJson", () => {
	it("returns an empty object for undefined input", () => {
		expect(parseStreamingJson(undefined)).toEqual({});
	});

	it("returns an empty object for whitespace-only input", () => {
		expect(parseStreamingJson("   ")).toEqual({});
	});

	it("parses complete JSON", () => {
		expect(parseStreamingJson('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
	});

	it("parses JSON that needs control-character repair", () => {
		expect(parseStreamingJson('{"a":"x\ny"}')).toEqual({ a: "x\ny" });
	});

	it("parses incomplete JSON via partial-json fallback", () => {
		expect(parseStreamingJson('{"a":1,"b":')).toEqual({ a: 1 });
	});

	it("falls back to an empty object when partial-json yields a nullish literal", () => {
		// `nul` is a truncated `null` literal. JSON.parse rejects it, repairJson
		// cannot change it, but partial-json parses it to `null`, which the
		// `result ?? {}` guard turns into an empty object.
		expect(parseStreamingJson("nul")).toEqual({});
	});

	it("parses a complete string with a raw NUL via the repaired partial-json fallback", () => {
		// A complete string literal carrying a raw control character: JSON.parse
		// rejects it, partial-json rejects the raw input ("Bad control character"),
		// but partial-json accepts the escaped/repaired form.
		const nul = String.fromCharCode(0);
		expect(parseStreamingJson(`"a${nul}b"`)).toBe(`a${nul}b`);
	});

	it("returns an empty object when every parsing strategy fails", () => {
		// Structurally impossible input: JSON.parse, partial-json, and the repaired
		// partial-json parse all throw, so the final catch returns {}.
		expect(parseStreamingJson("]]]")).toEqual({});
	});
});
