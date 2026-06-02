#!/usr/bin/env tsx

import { createCanvas } from "canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function generateTestImage(outputPath = join(__dirname, "..", "test", "data", "red-circle.png")): void {
	const canvas = createCanvas(200, 200);
	const ctx = canvas.getContext("2d");

	ctx.fillStyle = "white";
	ctx.fillRect(0, 0, 200, 200);

	ctx.fillStyle = "red";
	ctx.beginPath();
	ctx.arc(100, 100, 50, 0, Math.PI * 2);
	ctx.fill();

	const buffer = canvas.toBuffer("image/png");

	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, buffer);
	console.log(`Generated test image at: ${outputPath}`);
}

/* v8 ignore start -- Direct script entrypoint; tests call generateTestImage() with a temp output path. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	generateTestImage();
}
/* v8 ignore stop */
