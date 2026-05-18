import { defineConfig } from "vitest/config";

// ADR-0017: monorepo-wide 100% on all four v8 metrics. pi-models is the
// browser-safe model-registry data package (ADR-0005) — pure data + a
// handful of synchronous utilities. Coverage covers every src/**/*.ts
// including the .generated.ts files (per ADR-0017 minimal-excludes).
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
			reporter: ["text", "json-summary", "html", "lcov"],
			thresholds: {
				lines: 100,
				branches: 100,
				functions: 100,
				statements: 100,
			},
		},
	},
});
