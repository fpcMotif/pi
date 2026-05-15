import { describe, expect, it } from "vitest";
import * as diagnostics from "../src/core/diagnostics.js";

describe("diagnostics module", () => {
	it("is a pure type-only module with no runtime exports", () => {
		expect(Object.keys(diagnostics)).toEqual([]);
	});
});
