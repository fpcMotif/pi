import { defineConfig } from "vitest/config";

// ADR-0017: monorepo-wide 100% on all four v8 metrics. test-support/** is
// excluded from `include` since it's test infrastructure (ADR-0015).
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "effect/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**", "test/**", "test-support/**"],
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
