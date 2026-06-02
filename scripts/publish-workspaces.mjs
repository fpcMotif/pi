#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const help = args.includes("--help") || args.includes("-h");
const dryRun = args.includes("--dry-run");
const publishArgs = args.filter((arg) => arg !== "--list" && arg !== "--help" && arg !== "-h" && arg !== "--dry-run");

if (help) {
	console.log(`Usage: bun scripts/publish-workspaces.mjs [--list] [bun publish flags...]

Publishes non-private packages under packages/* in local dependency order.

Options:
  --list  Print the publish order without publishing

With --dry-run, each package is packed via bun pm pack --dry-run without contacting
the registry. Other flags are passed to bun publish for real publishes.
`);
	process.exit(0);
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

const packages = packagePaths().map((path) => {
	const data = readJson(path);
	return {
		path,
		dir: path.slice(0, -"package.json".length - 1),
		data,
	};
});
const publishable = packages.filter((pkg) => pkg.data.private !== true);
const publishableNames = new Set(publishable.map((pkg) => pkg.data.name));
const byName = new Map(publishable.map((pkg) => [pkg.data.name, pkg]));

function localDependencies(pkg) {
	const dependencyNames = [
		...Object.keys(pkg.data.dependencies ?? {}),
		...Object.keys(pkg.data.peerDependencies ?? {}),
		...Object.keys(pkg.data.optionalDependencies ?? {}),
	];
	return dependencyNames.filter((name) => publishableNames.has(name));
}

function publishOrder() {
	const ordered = [];
	const visiting = new Set();
	const visited = new Set();

	function visit(pkg) {
		if (visited.has(pkg.data.name)) return;
		if (visiting.has(pkg.data.name)) {
			throw new Error(`Cycle in workspace dependencies at ${pkg.data.name}`);
		}
		visiting.add(pkg.data.name);
		for (const depName of localDependencies(pkg)) {
			const dependency = byName.get(depName);
			if (dependency) visit(dependency);
		}
		visiting.delete(pkg.data.name);
		visited.add(pkg.data.name);
		ordered.push(pkg);
	}

	for (const pkg of publishable) {
		visit(pkg);
	}

	return ordered;
}

const orderedPackages = publishOrder();

if (listOnly) {
	for (const pkg of orderedPackages) {
		console.log(`${pkg.data.name}@${pkg.data.version}`);
	}
	process.exit(0);
}

for (const pkg of orderedPackages) {
	const commandArgs = dryRun
		? ["pm", "pack", "--dry-run", "--ignore-scripts"]
		: ["publish", "--access", "public", ...publishArgs];
	console.log(`$ bun ${commandArgs.join(" ")} (${pkg.dir})`);
	const result = spawnSync("bun", commandArgs, {
		cwd: pkg.dir,
		stdio: "inherit",
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
