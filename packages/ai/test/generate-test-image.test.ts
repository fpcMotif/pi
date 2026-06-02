import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateTestImage } from "../scripts/generate-test-image.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("generate-test-image", () => {
	it("writes a PNG image to the requested path", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const tempDir = mkdtempSync(join(tmpdir(), "pi-test-image-"));
		const outputPath = join(tempDir, "nested", "red-circle.png");

		generateTestImage(outputPath);

		const bytes = readFileSync(outputPath);
		expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(bytes.length).toBeGreaterThan(1000);
		expect(logSpy).toHaveBeenCalledWith(`Generated test image at: ${outputPath}`);
	});
});
