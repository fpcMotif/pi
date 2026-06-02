#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const help = args.includes("--help") || args.includes("-h");
const target = args.find((arg) => arg !== "--dry-run");

if (help) {
	console.log("Usage: bun scripts/version-workspaces.mjs <major|minor|patch|x.y.z> [--dry-run]");
	process.exit(0);
}

if (!target || (!BUMP_TYPES.has(target) && !SEMVER_RE.test(target))) {
	console.error("Usage: bun scripts/version-workspaces.mjs <major|minor|patch|x.y.z> [--dry-run]");
	process.exit(1);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packagePaths() {
	const packagesDir = join(process.cwd(), "packages");
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(packagesDir, entry.name, "package.json"))
		.filter((path) => existsSync(path));
}

function bumpVersion(version, type) {
	const match = SEMVER_RE.exec(version);
	if (!match) {
		throw new Error(`Cannot ${type}-bump non-semver package version: ${version}`);
	}
	const [, majorRaw, minorRaw, patchRaw] = match;
	let major = Number(majorRaw);
	let minor = Number(minorRaw);
	let patch = Number(patchRaw);

	switch (type) {
		case "major":
			major += 1;
			minor = 0;
			patch = 0;
			break;
		case "minor":
			minor += 1;
			patch = 0;
			break;
		case "patch":
			patch += 1;
			break;
	}

	return `${major}.${minor}.${patch}`;
}

const packages = packagePaths().map((path) => ({ path, data: readJson(path) }));
const versions = new Set(packages.map((pkg) => pkg.data.version));

if (versions.size !== 1) {
	console.error("Package versions are not lockstep:");
	for (const pkg of packages) {
		console.error(`  ${pkg.data.name}: ${pkg.data.version}`);
	}
	process.exit(1);
}

const [currentVersion] = versions;
const nextVersion = BUMP_TYPES.has(target) ? bumpVersion(currentVersion, target) : target;

if (nextVersion === currentVersion) {
	console.error(`Package version is already ${nextVersion}.`);
	process.exit(1);
}

for (const pkg of packages) {
	pkg.data.version = nextVersion;
	if (!dryRun) {
		writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
	}
}

const action = dryRun ? "Would update" : "Updated";
console.log(`${action} ${packages.length} package versions: ${currentVersion} -> ${nextVersion}`);
