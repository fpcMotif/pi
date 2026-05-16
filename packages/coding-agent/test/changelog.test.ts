import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareVersions, getChangelogPath, getNewEntries, parseChangelog } from "../src/utils/changelog.js";

describe("parseChangelog", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-changelog-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array when file does not exist", () => {
		expect(parseChangelog(join(tempDir, "missing.md"))).toEqual([]);
	});

	it("returns empty array on read errors (catches and logs)", () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// Create a directory where a file is expected → readFileSync throws
		const path = join(tempDir, "isDir");
		require("node:fs").mkdirSync(path);
		expect(parseChangelog(path)).toEqual([]);
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Could not parse"));
		errSpy.mockRestore();
	});

	it("parses standard CHANGELOG.md format with brackets", () => {
		const path = join(tempDir, "CHANGELOG.md");
		writeFileSync(
			path,
			[
				"# Changelog",
				"",
				"## [1.2.3] - 2024-01-01",
				"- Feature A",
				"- Feature B",
				"",
				"## [1.2.2] - 2023-12-01",
				"- Bug fix",
			].join("\n"),
		);
		const entries = parseChangelog(path);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ major: 1, minor: 2, patch: 3 });
		expect(entries[0].content).toContain("Feature A");
		expect(entries[1]).toMatchObject({ major: 1, minor: 2, patch: 2 });
		expect(entries[1].content).toContain("Bug fix");
	});

	it("parses version headers without brackets", () => {
		const path = join(tempDir, "CHANGELOG.md");
		writeFileSync(path, ["## 0.5.0", "- something", ""].join("\n"));
		const entries = parseChangelog(path);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ major: 0, minor: 5, patch: 0 });
	});

	it("ignores ## headers that aren't version-like", () => {
		const path = join(tempDir, "CHANGELOG.md");
		writeFileSync(path, ["## Unreleased", "- pending", "## [1.0.0]", "- release"].join("\n"));
		const entries = parseChangelog(path);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ major: 1, minor: 0, patch: 0 });
	});

	it("returns empty when no version headers", () => {
		const path = join(tempDir, "CHANGELOG.md");
		writeFileSync(path, "# Header\n\nSome text without version headers.");
		const entries = parseChangelog(path);
		expect(entries).toEqual([]);
	});
});

describe("compareVersions", () => {
	const make = (major: number, minor: number, patch: number) => ({ major, minor, patch, content: "" });

	it("compares major versions", () => {
		expect(compareVersions(make(2, 0, 0), make(1, 9, 9))).toBeGreaterThan(0);
		expect(compareVersions(make(1, 0, 0), make(2, 0, 0))).toBeLessThan(0);
	});

	it("compares minor versions when major equal", () => {
		expect(compareVersions(make(1, 2, 0), make(1, 1, 9))).toBeGreaterThan(0);
		expect(compareVersions(make(1, 1, 0), make(1, 2, 0))).toBeLessThan(0);
	});

	it("compares patch versions when major+minor equal", () => {
		expect(compareVersions(make(1, 2, 3), make(1, 2, 2))).toBeGreaterThan(0);
		expect(compareVersions(make(1, 2, 1), make(1, 2, 2))).toBeLessThan(0);
	});

	it("returns 0 for equal versions", () => {
		expect(compareVersions(make(1, 2, 3), make(1, 2, 3))).toBe(0);
	});
});

describe("getNewEntries", () => {
	const make = (major: number, minor: number, patch: number) => ({ major, minor, patch, content: "" });

	it("returns only entries newer than lastVersion", () => {
		const entries = [make(2, 0, 0), make(1, 5, 0), make(1, 0, 0)];
		const result = getNewEntries(entries, "1.5.0");
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ major: 2, minor: 0, patch: 0 });
	});

	it("returns empty when no entries are newer", () => {
		const entries = [make(1, 0, 0)];
		expect(getNewEntries(entries, "2.0.0")).toEqual([]);
	});

	it("parses missing version parts as 0", () => {
		const entries = [make(0, 1, 0)];
		const result = getNewEntries(entries, "0");
		expect(result).toHaveLength(1);
	});

	it("returns all entries when lastVersion is 0.0.0", () => {
		const entries = [make(0, 0, 1), make(1, 0, 0)];
		expect(getNewEntries(entries, "0.0.0")).toHaveLength(2);
	});
});

describe("getChangelogPath re-export", () => {
	it("is re-exported from config", () => {
		expect(typeof getChangelogPath).toBe("function");
	});
});
