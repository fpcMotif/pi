// ADR-0017: type-only modules must compile away to empty runtime modules.
// Importing them here makes coverage measure the files instead of skipping
// them as unloaded; the assertions guard against a runtime value (e.g. an
// accidental `export const`) slipping into the type surface.
import { describe, expect, it } from "vitest";
import * as sandboxRuntimeProviderTypes from "../src/components/sandbox/SandboxRuntimeProvider.js";
import * as storageTypes from "../src/storage/types.js";
import * as toolTypes from "../src/tools/types.js";

describe("type-only modules", () => {
	it("storage/types.ts has no runtime exports", () => {
		expect(Object.keys(storageTypes)).toEqual([]);
	});

	it("tools/types.ts has no runtime exports", () => {
		expect(Object.keys(toolTypes)).toEqual([]);
	});

	it("components/sandbox/SandboxRuntimeProvider.ts has no runtime exports", () => {
		expect(Object.keys(sandboxRuntimeProviderTypes)).toEqual([]);
	});
});
