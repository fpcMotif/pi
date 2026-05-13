import { defineConfig } from "vitest/config";

// ADR-0017: ported from `node --test --import tsx` to vitest+v8 for
// monorepo-wide 100% coverage on all four metrics. pi-tui is NOT touched
// by the Effect rewrite (CONTEXT-MAP ¶9), so these tests + this config
// are durable beyond the 1.0 cutover.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 30000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**", "test/**"],
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
