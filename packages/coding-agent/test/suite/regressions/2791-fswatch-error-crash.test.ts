import { type FSWatcher, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getThemeWatcherForTesting, setTheme, stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.js";

/**
 * Regression test for https://github.com/earendil-works/pi-mono/issues/2791
 *
 * fs.watch() returns an FSWatcher (EventEmitter). If the watcher emits an
 * 'error' event after creation and no error handler is attached, Node.js
 * treats it as an uncaught exception and terminates the process.
 *
 * The theme watcher must attach an error listener so an async filesystem error
 * closes the watcher instead of terminating the process.
 */
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
		const agentDir = join(tempRoot, "agent");
		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		// Copy dark.json as "custom-test" theme
		const darkThemePath = join(__dirname, "../../../src/modes/interactive/theme/dark.json");
		const darkTheme = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		darkTheme.name = "custom-test";
		writeFileSync(join(themesDir, "custom-test.json"), JSON.stringify(darkTheme, null, 2));
	});

	afterEach(() => {
		stopThemeWatcher();
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		expect(setTheme("custom-test", true).success).toBe(true);
		const watcher = getThemeWatcherForTesting() as FSWatcher | undefined;

		expect(watcher).toBeDefined();
		expect(watcher?.listenerCount("error")).toBeGreaterThan(0);
		expect(() => watcher?.emit("error", new Error("simulated OS watcher failure"))).not.toThrow();
		expect(getThemeWatcherForTesting()).toBeUndefined();
	});
});
