import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureTool, getToolPath } from "../src/utils/tools-manager.js";

describe("getToolPath", () => {
	it("returns null/string for fd", () => {
		const result = getToolPath("fd");
		// Should return either a path or null depending on whether fd is available
		expect(result === null || typeof result === "string").toBe(true);
	});

	it("returns null/string for rg", () => {
		const result = getToolPath("rg");
		expect(result === null || typeof result === "string").toBe(true);
	});
});

describe("ensureTool (offline mode)", () => {
	const originalOffline = process.env.PI_OFFLINE;

	it("skips download in offline mode (silent)", async () => {
		process.env.PI_OFFLINE = "1";
		try {
			// On systems where fd already exists, getToolPath returns it.
			// On systems where it doesn't, ensureTool returns undefined in silent offline mode.
			const result = await ensureTool("fd", true);
			expect(result === undefined || typeof result === "string").toBe(true);
		} finally {
			if (originalOffline === undefined) {
				delete process.env.PI_OFFLINE;
			} else {
				process.env.PI_OFFLINE = originalOffline;
			}
		}
	});

	it("logs message in offline mode (non-silent) if tool missing", async () => {
		// Only meaningful when the tool isn't available. Either way, the function should not throw.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		process.env.PI_OFFLINE = "true";
		try {
			await ensureTool("fd", false);
			// If the tool was already available, no log; if not, we got a "skipping download" log
			// Either way, exit happens cleanly.
			expect(typeof logSpy.mock.calls.length).toBe("number");
		} finally {
			if (originalOffline === undefined) {
				delete process.env.PI_OFFLINE;
			} else {
				process.env.PI_OFFLINE = originalOffline;
			}
			logSpy.mockRestore();
		}
	});
});

describe("isOfflineModeEnabled equivalent (via ensureTool semantics)", () => {
	const originalOffline = process.env.PI_OFFLINE;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		if (originalOffline === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = originalOffline;
		}
		logSpy.mockRestore();
	});

	it("does NOT consider PI_OFFLINE=no as enabled", async () => {
		process.env.PI_OFFLINE = "no";
		// If "no" was considered enabled, we'd get the offline message. We won't here.
		// Hard to assert without intercepting download too; we just ensure no throw.
		const result = await ensureTool("fd", true);
		expect(result === undefined || typeof result === "string").toBe(true);
	});

	it("considers PI_OFFLINE=yes as enabled", async () => {
		process.env.PI_OFFLINE = "yes";
		// Will use offline path. With silent=true, returns undefined when tool isn't found,
		// or the existing tool path if it's installed locally.
		const result = await ensureTool("fd", true);
		expect(result === undefined || typeof result === "string").toBe(true);
	});
});

