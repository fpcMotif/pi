import { defineConfig } from "vitest/config";

// ADR-0017: pi-ai is deprecated per ADR-0005 but in coverage scope as a
// forcing function to surface dead/buggy legacy behavior before the
// package is removed from the worktree at the 1.0 cutover.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**", "test/**", "scripts/**"],
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
