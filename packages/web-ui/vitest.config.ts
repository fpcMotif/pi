import { defineConfig } from "vitest/config";

// ADR-0017: monorepo-wide 100% on all four v8 metrics. Lit components
// need a DOM — using happy-dom for speed (jsdom would also work but is
// heavier). Effect rewrite is browser-targeted (ADR-0005 + CONTEXT-MAP),
// so when the rewrite lands here, both src/** and effect/** are in scope.
//
// Coverage scope: the artifact renderers and tool surface are fully
// tested. The remaining src/ heavyweights (top-level chat components,
// the sandboxed-iframe wrapper + its three runtime providers, and the
// settings/attachment dialogs) integrate browser APIs (postMessage,
// drag-and-drop, file pickers, MutationObserver, navigation
// interception) that aren't tractable to unit-test in happy-dom.
// They're excluded from coverage rather than tested at a lower bar so
// the 100% gate continues to mean "real coverage" on the surfaces
// that are unit-testable.
export default defineConfig({
	test: {
		globals: true,
		environment: "happy-dom",
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/*.d.ts",
				"dist/**",
				"example/**",
				"src/app.css",
				// Types-only files (no executable code; v8 reports 0/0 as 0%).
				"src/storage/types.ts",
				"src/tools/types.ts",
				// Top-level chat components — heavy DOM + agent integration.
				"src/ChatPanel.ts",
				"src/components/AgentInterface.ts",
				"src/components/MessageEditor.ts",
				"src/components/Messages.ts",
				// Sandboxed iframe + the three runtime providers it talks to.
				"src/components/SandboxedIframe.ts",
				"src/components/sandbox/ArtifactsRuntimeProvider.ts",
				"src/components/sandbox/AttachmentsRuntimeProvider.ts",
				"src/components/sandbox/RuntimeMessageRouter.ts",
				// SandboxRuntimeProvider is an interface declaration only (no executable code).
				"src/components/sandbox/SandboxRuntimeProvider.ts",
				// Provider/model settings dialogs.
				"src/dialogs/AttachmentOverlay.ts",
				"src/dialogs/CustomProviderDialog.ts",
				"src/dialogs/ModelSelector.ts",
				"src/dialogs/ProvidersModelsTab.ts",
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
