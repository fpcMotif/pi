import { describe, expect, it } from "vitest";
import * as types from "../src/types.js";

// src/types.ts is the package's public type surface: interfaces, type aliases,
// and `import type` declarations only. It must compile away to an empty runtime
// module. Importing it here makes coverage measure the file instead of skipping
// it as unloaded, and the assertion guards against a runtime value (e.g. an
// accidental `export const`) slipping into the type surface.
describe("types module", () => {
	it("is a pure type-only module with no runtime exports", () => {
		expect(Object.keys(types)).toEqual([]);
	});
});
