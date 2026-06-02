import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRouterImageModels, generateImageModelsFile, main } from "../scripts/generate-image-models.js";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("generate-image-models", () => {
	it("fetches OpenRouter image models, filters non-image outputs, and normalizes pricing", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		global.fetch = vi.fn(async (): Promise<Response> => {
			return Response.json({
				data: [
					{
						id: "z-image",
						name: "Z Image",
						architecture: {
							input_modalities: ["text", "image", "audio", "text"],
							output_modalities: ["image", "text", "image"],
						},
						pricing: {
							prompt: "0.000001",
							completion: "0.000002",
							input_cache_read: "0.00000025",
							input_cache_write: "0.0000005",
						},
					},
					{
						id: "text-only",
						name: "Text Only",
						architecture: {
							input_modalities: ["text"],
							output_modalities: ["text"],
						},
					},
					{
						id: "default-input",
						name: "Default Input",
						architecture: {
							input_modalities: [],
							output_modalities: ["image"],
						},
					},
				],
			});
		}) as typeof fetch;

		await expect(fetchOpenRouterImageModels()).resolves.toEqual([
			{
				id: "z-image",
				name: "Z Image",
				api: "openrouter-images",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				input: ["text", "image"],
				output: ["image", "text"],
				cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
			},
			{
				id: "default-input",
				name: "Default Input",
				api: "openrouter-images",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				input: ["text"],
				output: ["image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		]);
		expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models?output_modalities=image");
	});

	it("tolerates missing OpenRouter model arrays and architecture metadata", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		global.fetch = vi.fn(async (): Promise<Response> => {
			return Response.json({
				data: [
					{
						id: "missing-architecture",
						name: "Missing Architecture",
					},
				],
			});
		}) as typeof fetch;

		await expect(fetchOpenRouterImageModels()).resolves.toEqual([]);

		global.fetch = vi.fn(async (): Promise<Response> => Response.json({})) as typeof fetch;

		await expect(fetchOpenRouterImageModels()).resolves.toEqual([]);
	});

	it("returns an empty model list when OpenRouter fetch or parsing fails", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		global.fetch = vi.fn(async (): Promise<Response> => {
			throw new Error("network down");
		}) as typeof fetch;

		await expect(fetchOpenRouterImageModels()).resolves.toEqual([]);
		expect(errorSpy).toHaveBeenCalledWith("Failed to fetch OpenRouter image models:", expect.any(Error));
	});

	it("generates sorted Bun-first TypeScript output and writes it from main", async () => {
		global.fetch = vi.fn(async (): Promise<Response> => {
			return Response.json({
				data: [
					{
						id: "b-model",
						name: "B Model",
						architecture: { input_modalities: ["text"], output_modalities: ["image"] },
					},
					{
						id: "a-model",
						name: "A Model",
						architecture: { input_modalities: ["image"], output_modalities: ["image"] },
					},
				],
			});
		}) as typeof fetch;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const tempDir = mkdtempSync(join(tmpdir(), "pi-image-models-"));
		const outputPath = join(tempDir, "image-models.generated.ts");

		await main(outputPath);

		const generated = readFileSync(outputPath, "utf8");
		expect(generated).toContain("run 'bun run generate-image-models' to update");
		expect(generated.indexOf('"a-model"')).toBeLessThan(generated.indexOf('"b-model"'));
		expect(generated).toBe(generateImageModelsFile(await fetchOpenRouterImageModels()));
		expect(logSpy).toHaveBeenCalledWith(`Generated ${outputPath}`);
	});
});
