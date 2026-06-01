import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("timings (PI_TIMING enabled)", () => {
	const originalEnv = process.env.PI_TIMING;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		process.env.PI_TIMING = "1";
		// Re-import the module to pick up env change
		vi.resetModules();
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_TIMING;
		} else {
			process.env.PI_TIMING = originalEnv;
		}
		errSpy.mockRestore();
		vi.resetModules();
	});

	it("captures and prints timings when enabled", async () => {
		const mod = await import("../src/core/timings.js");
		mod.resetTimings();
		mod.time("step-1");
		mod.time("step-2");
		mod.printTimings();
		// Print called console.error (header + timings + total)
		expect(errSpy).toHaveBeenCalled();
		const calls = errSpy.mock.calls.flat().join("\n");
		expect(calls).toContain("Startup Timings");
		expect(calls).toContain("step-1");
		expect(calls).toContain("step-2");
		expect(calls).toContain("TOTAL");
	});

	it("printTimings is silent when no entries", async () => {
		const mod = await import("../src/core/timings.js");
		mod.resetTimings();
		mod.printTimings();
		expect(errSpy).not.toHaveBeenCalled();
	});
});

describe("timings (PI_TIMING disabled)", () => {
	const originalEnv = process.env.PI_TIMING;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		delete process.env.PI_TIMING;
		vi.resetModules();
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_TIMING = originalEnv;
		}
		errSpy.mockRestore();
		vi.resetModules();
	});

	it("resetTimings, time, printTimings are all no-ops when disabled", async () => {
		const mod = await import("../src/core/timings.js");
		mod.resetTimings();
		mod.time("step-1");
		mod.printTimings();
		expect(errSpy).not.toHaveBeenCalled();
	});
});
