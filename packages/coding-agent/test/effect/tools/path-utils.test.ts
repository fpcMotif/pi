import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { resolveOptionalToolPath, resolveToolPath } from "../../../effect/tools/path-utils.js";

describe("tool path resolution", () => {
	const cwd = nodePath.resolve("/workspace/project");
	const nested = nodePath.join(cwd, "src", "index.ts");

	it("resolves relative paths and strips path mention prefixes", () => {
		expect(resolveToolPath(cwd, "src/index.ts")).toBe(nested);
		expect(resolveToolPath(cwd, "@src/index.ts")).toBe(nested);
	});

	it("preserves absolute paths after optional path mention prefix stripping", () => {
		const absolute = nodePath.resolve("/outside/file.txt");

		expect(resolveToolPath(cwd, absolute)).toBe(absolute);
		expect(resolveToolPath(cwd, `@${absolute}`)).toBe(absolute);
	});

	it("defaults optional blank path inputs to cwd", () => {
		expect(resolveOptionalToolPath(cwd, undefined)).toBe(cwd);
		expect(resolveOptionalToolPath(cwd, "")).toBe(cwd);
		expect(resolveOptionalToolPath(cwd, "@")).toBe(cwd);
	});
});
