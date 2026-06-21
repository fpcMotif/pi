#!/usr/bin/env node

/**
 * Bumps every workspace package under packages/* to a new version, in lockstep.
 *
 * Replaces `npm version <type> -ws`. `bun pm version` has no workspace-recursion
 * flag, so it would only bump the (private, never-published) root package and
 * leave every publishable workspace untouched — silently shipping the same
 * version on every release. sync-versions.js only *checks* lockstep and rewrites
 * inter-package dependency ranges; it never bumps, so the bump has to happen here.
 *
 * Usage: node scripts/bump-versions.mjs <major|minor|patch|x.y.z>
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const target = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!target || (!BUMP_TYPES.has(target) && !SEMVER_RE.test(target))) {
	console.error("Usage: node scripts/bump-versions.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

const packagesDir = join(process.cwd(), "packages");
const pkgs = [];
const versions = new Set();

for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!dirent.isDirectory()) continue;
	const path = join(packagesDir, dirent.name, "package.json");
	let data;
	try {
		data = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		continue; // not every packages/* dir carries a package.json
	}
	if (typeof data.version !== "string") continue;
	pkgs.push({ path, data });
	versions.add(data.version);
}

if (pkgs.length === 0) {
	console.error("❌ No versioned workspace packages found under packages/*");
	process.exit(1);
}

if (versions.size > 1) {
	console.error(`❌ Workspaces are not in lockstep: ${[...versions].sort().join(", ")}`);
	console.error("Fix the versions to match before bumping.");
	process.exit(1);
}

const current = [...versions][0];
const next = BUMP_TYPES.has(target) ? bump(current, target) : target;

if (!BUMP_TYPES.has(target) && compareVersions(next, current) <= 0) {
	console.error(`❌ Explicit version ${next} must be greater than current version ${current}.`);
	process.exit(1);
}

for (const { path, data } of pkgs) {
	data.version = next;
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
	console.log(`  ${data.name}: ${current} → ${next}`);
}
console.log(`\n✅ Bumped ${pkgs.length} workspace package(s) to ${next}`);

function bump(version, type) {
	const [major, minor, patch] = version.split(".").map(Number);
	if (type === "major") return `${major + 1}.0.0`;
	if (type === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
