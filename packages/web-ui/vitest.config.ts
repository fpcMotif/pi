import { defineConfig } from "vitest/config";

// ADR-0017: monorepo-wide 100% on all four v8 metrics. Lit components
// need a DOM — using happy-dom for speed (jsdom would also work but is
// heavier). Effect rewrite is browser-targeted (ADR-0005 + CONTEXT-MAP),
// so when the rewrite lands here, both src/** and effect/** are in scope.
export default defineConfig({
	test: {
		globals: true,
		environment: "happy-dom",
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**", "example/**", "src/app.css"],
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
