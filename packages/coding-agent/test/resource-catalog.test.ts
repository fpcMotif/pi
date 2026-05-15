import { describe, expect, it } from "vitest";
import { type PathMetadata, ResourceCatalog, resourcePrecedenceRank } from "../src/core/resource-catalog.js";

const metadata = (source: string, scope: PathMetadata["scope"], origin: PathMetadata["origin"]): PathMetadata => ({
	source,
	scope,
	origin,
});

describe("ResourceCatalog", () => {
	it("orders resources by policy precedence before exposing resolved paths", () => {
		const catalog = new ResourceCatalog();
		catalog.add("prompts", "/user/local.md", metadata("local", "user", "top-level"), true);
		catalog.add("prompts", "/package/prompt.md", metadata("pkg", "user", "package"), true);
		catalog.add("prompts", "/project/auto.md", metadata("auto", "project", "top-level"), true);
		catalog.add("prompts", "/project/local.md", metadata("local", "project", "top-level"), false);

		expect(catalog.toResolvedPaths().prompts.map((resource) => resource.path)).toEqual([
			"/project/local.md",
			"/project/auto.md",
			"/user/local.md",
			"/package/prompt.md",
		]);
		expect(catalog.toResolvedPaths().prompts[0]?.enabled).toBe(false);
	});

	it("keeps first discovered record for an exact path", () => {
		const catalog = new ResourceCatalog();
		catalog.add("skills", "/same/SKILL.md", metadata("auto", "user", "top-level"), true);
		catalog.add("skills", "/same/SKILL.md", metadata("local", "project", "top-level"), false);

		const [skill] = catalog.toResolvedPaths().skills;
		expect(skill?.metadata.scope).toBe("user");
		expect(skill?.enabled).toBe(true);
	});

	it("exposes precedence rank as a pure policy helper", () => {
		expect(resourcePrecedenceRank(metadata("local", "project", "top-level"))).toBeLessThan(
			resourcePrecedenceRank(metadata("auto", "user", "top-level")),
		);
		expect(resourcePrecedenceRank(metadata("anything", "project", "package"))).toBe(4);
	});
});
