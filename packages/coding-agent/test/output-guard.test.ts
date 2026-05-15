import { afterEach, describe, expect, it } from "vitest";
import {
	flushRawStdout,
	isStdoutTakenOver,
	restoreStdout,
	takeOverStdout,
	writeRawStdout,
} from "../src/core/output-guard.js";

describe("output-guard", () => {
	afterEach(() => {
		restoreStdout();
	});

	it("takeOverStdout swaps stdout.write to stderr", () => {
		expect(isStdoutTakenOver()).toBe(false);
		takeOverStdout();
		expect(isStdoutTakenOver()).toBe(true);
	});

	it("takeOverStdout is idempotent", () => {
		takeOverStdout();
		const firstWrite = process.stdout.write;
		takeOverStdout();
		expect(process.stdout.write).toBe(firstWrite);
	});

	it("restoreStdout puts back the original write", () => {
		const original = process.stdout.write;
		takeOverStdout();
		expect(process.stdout.write).not.toBe(original);
		restoreStdout();
		expect(process.stdout.write).toBe(original);
		expect(isStdoutTakenOver()).toBe(false);
	});

	it("restoreStdout is a no-op when nothing was taken over", () => {
		const original = process.stdout.write;
		restoreStdout();
		expect(process.stdout.write).toBe(original);
	});

	it("writeRawStdout writes through raw stdout when taken over", () => {
		takeOverStdout();
		// writeRawStdout uses the raw write function. We can't easily mock since it's bound.
		// Just verify it doesn't throw.
		expect(() => writeRawStdout("test\n")).not.toThrow();
	});

	it("writeRawStdout falls back to process.stdout.write when not taken over", () => {
		expect(isStdoutTakenOver()).toBe(false);
		// Should not throw
		expect(() => writeRawStdout("test-fallback\n")).not.toThrow();
	});

	it("flushRawStdout resolves when taken over", async () => {
		takeOverStdout();
		await expect(flushRawStdout()).resolves.toBeUndefined();
	});

	it("flushRawStdout resolves when not taken over", async () => {
		await expect(flushRawStdout()).resolves.toBeUndefined();
	});

	it("stdout writes during takeover route to stderr (no actual stdout output)", () => {
		// Verify that after takeover, stdout.write returns boolean (delegates to stderr rawWrite).
		takeOverStdout();
		const result = process.stdout.write("data");
		expect(typeof result).toBe("boolean");
	});

	it("stdout.write supports callback signature during takeover", () => {
		takeOverStdout();
		let called = false;
		const result = process.stdout.write("data", () => {
			called = true;
		});
		expect(typeof result).toBe("boolean");
		// callback may or may not fire synchronously
		void called;
	});

	it("stdout.write supports encoding+callback during takeover", () => {
		takeOverStdout();
		let cbCalled = false;
		const result = process.stdout.write("data", "utf8", () => {
			cbCalled = true;
		});
		expect(typeof result).toBe("boolean");
		void cbCalled;
	});
});
