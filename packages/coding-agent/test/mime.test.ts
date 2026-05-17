import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectSupportedImageMimeTypeFromFile } from "../src/utils/mime.js";

// 1x1 PNG (transparent)
const PNG_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
	0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// Minimal JPEG header bytes
const JPEG_BYTES = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
	0x00, 0xff, 0xd9,
]);

describe("detectSupportedImageMimeTypeFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-mime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects PNG", async () => {
		const file = join(tempDir, "img.png");
		writeFileSync(file, PNG_BYTES);
		const mime = await detectSupportedImageMimeTypeFromFile(file);
		expect(mime).toBe("image/png");
	});

	it("detects JPEG", async () => {
		const file = join(tempDir, "img.jpg");
		writeFileSync(file, JPEG_BYTES);
		const mime = await detectSupportedImageMimeTypeFromFile(file);
		expect(mime).toBe("image/jpeg");
	});

	it("returns null for empty file", async () => {
		const file = join(tempDir, "empty");
		writeFileSync(file, "");
		const mime = await detectSupportedImageMimeTypeFromFile(file);
		expect(mime).toBeNull();
	});

	it("returns null for non-image file", async () => {
		const file = join(tempDir, "text.txt");
		writeFileSync(file, "hello world");
		const mime = await detectSupportedImageMimeTypeFromFile(file);
		expect(mime).toBeNull();
	});
});
