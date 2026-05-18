// ADR-0017 phase C.7: cover the prompts/prompts.ts string-and-template
// constants. Two functions (JAVASCRIPT_REPL_TOOL_DESCRIPTION,
// ARTIFACTS_TOOL_DESCRIPTION) accept a list of runtime-provider
// descriptions; the rest are bare string constants.
import { describe, expect, it } from "vitest";

import {
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO,
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW,
	ARTIFACTS_TOOL_DESCRIPTION,
	ATTACHMENTS_RUNTIME_DESCRIPTION,
	EXTRACT_DOCUMENT_DESCRIPTION,
	JAVASCRIPT_REPL_TOOL_DESCRIPTION,
} from "../src/prompts/prompts.js";

describe("prompts.ts string constants", () => {
	it.each([
		["ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO", ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO],
		["ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW", ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW],
		["ATTACHMENTS_RUNTIME_DESCRIPTION", ATTACHMENTS_RUNTIME_DESCRIPTION],
		["EXTRACT_DOCUMENT_DESCRIPTION", EXTRACT_DOCUMENT_DESCRIPTION],
	])("%s is a non-empty string", (_name, value) => {
		expect(typeof value).toBe("string");
		expect(value.length).toBeGreaterThan(0);
	});
});

describe("JAVASCRIPT_REPL_TOOL_DESCRIPTION (template function)", () => {
	it("returns a non-empty string with the tool name", () => {
		const out = JAVASCRIPT_REPL_TOOL_DESCRIPTION([]);
		expect(out).toContain("JavaScript REPL");
	});

	it("interpolates runtime-provider descriptions into the output", () => {
		const out = JAVASCRIPT_REPL_TOOL_DESCRIPTION(["my-runtime-provider"]);
		expect(out).toContain("my-runtime-provider");
	});

	it("works with multiple runtime-provider descriptions", () => {
		const out = JAVASCRIPT_REPL_TOOL_DESCRIPTION(["rt-a", "rt-b"]);
		expect(out).toContain("rt-a");
		expect(out).toContain("rt-b");
	});
});

describe("ARTIFACTS_TOOL_DESCRIPTION (template function)", () => {
	it("returns a non-empty string with the tool name", () => {
		const out = ARTIFACTS_TOOL_DESCRIPTION([]);
		expect(out).toContain("Artifacts");
	});

	it("interpolates runtime-provider descriptions", () => {
		const out = ARTIFACTS_TOOL_DESCRIPTION(["custom-rt"]);
		expect(out).toContain("custom-rt");
	});
});
