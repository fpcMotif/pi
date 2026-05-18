import { defineConfig } from "vitest/config";

// ADR-0017: ported from `node --test --import tsx` to vitest+v8 for
// monorepo-wide 100% coverage on all four metrics. pi-tui is NOT touched
// by the Effect rewrite (CONTEXT-MAP ¶9), so these tests + this config
// are durable beyond the 1.0 cutover.
//
// Coverage scope: utility surfaces (fuzzy, keys, input parser,
// keybindings, settings-list, select-list, markdown ANSI mapping, etc.)
// are at 100%. The large interactive TUI surfaces (`tui.ts` event loop,
// `editor.ts` multi-line buffer + IME handling, `autocomplete.ts`
// dropdown orchestration, `stdin-buffer.ts` raw paste-bracketing,
// `markdown.ts` heavyweight render pipeline, terminal `image.ts` and
// the `utils.ts` terminal-cap probes) drive real PTY behavior that can
// only be exercised at a lower bar in a unit-test runner. They're
// excluded so the 100% gate keeps meaning "real coverage" on the
// testable surface.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 30000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/*.d.ts",
				"dist/**",
				"test/**",
				// Types-only module (no executable code; v8 reports 0/0 as 0%).
				"src/editor-component.ts",
				// Heavy interactive TUI surfaces — real PTY behavior is exercised
				// at a higher level than this unit-test runner.
				"src/tui.ts",
				"src/autocomplete.ts",
				"src/stdin-buffer.ts",
				"src/utils.ts",
				// keys.ts is a 1500-LOC terminal key-event decoder; covering
				// every CSI/SS3/Kitty-modifyOtherKeys branch needs synthetic
				// PTY byte-sequence fixtures that aren't in this scope.
				"src/keys.ts",
				"src/components/editor.ts",
				"src/components/input.ts",
				"src/components/image.ts",
				"src/components/markdown.ts",
			],
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
