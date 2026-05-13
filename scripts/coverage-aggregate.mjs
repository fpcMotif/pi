#!/usr/bin/env node
// ADR-0017: aggregate per-workspace v8 coverage json-summary files into a
// single monorepo-wide report. Exits non-zero if ANY package is below 100%
// on ANY of lines/branches/functions/statements. Runs AFTER per-workspace
// test:coverage:100 (which already enforces thresholds — this is a
// belt-and-suspenders aggregator for the unified report).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = [
	{ dir: "packages/tui", name: "@earendil-works/pi-tui" },
	{ dir: "packages/models", name: "@earendil-works/pi-models" },
	{ dir: "packages/ai", name: "@earendil-works/pi-ai" },
	{ dir: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ dir: "packages/coding-agent", name: "@earendil-works/pi-coding-agent" },
	{ dir: "packages/web-ui", name: "@earendil-works/pi-web-ui" },
];

const METRICS = ["lines", "statements", "functions", "branches"];

let failed = false;
const rows = [];

for (const pkg of PACKAGES) {
	const summary = join(pkg.dir, "coverage", "coverage-summary.json");
	if (!existsSync(summary)) {
		rows.push({ name: pkg.name, status: "NO-SUMMARY", lines: "-", statements: "-", functions: "-", branches: "-" });
		failed = true;
		continue;
	}
	const data = JSON.parse(readFileSync(summary, "utf8"));
	const total = data.total ?? {};
	const row = { name: pkg.name, status: "OK" };
	for (const metric of METRICS) {
		const pct = total[metric]?.pct ?? 0;
		row[metric] = pct;
		if (pct < 100) {
			row.status = "FAIL";
			failed = true;
		}
	}
	rows.push(row);
}

const pad = (s, n) => String(s).padEnd(n);
const fmtPct = (v) => (typeof v === "number" ? `${v.toFixed(2)}%` : v);
console.log("\nMonorepo coverage (ADR-0017 — 100% on all four metrics):\n");
console.log(pad("package", 40), pad("status", 11), pad("lines", 9), pad("stmts", 9), pad("funcs", 9), pad("branches", 9));
console.log("-".repeat(95));
for (const r of rows) {
	console.log(
		pad(r.name, 40),
		pad(r.status, 11),
		pad(fmtPct(r.lines), 9),
		pad(fmtPct(r.statements), 9),
		pad(fmtPct(r.functions), 9),
		pad(fmtPct(r.branches), 9),
	);
}
console.log();
if (failed) {
	console.error("Coverage below 100% threshold; see per-package reports under packages/*/coverage/index.html");
	process.exit(1);
}
console.log("All packages at 100% on all four metrics.");
