import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/images.js";
import type { ImagesContext, ImagesModel } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastRequestOptions: undefined as unknown,
	lastClientOptions: undefined as unknown,
	nextResponse: undefined as unknown,
	nextError: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: (params: unknown, requestOptions?: unknown) => {
					mockState.lastParams = params;
					mockState.lastRequestOptions = requestOptions;
					if (mockState.nextError !== undefined) {
						const error = mockState.nextError;
						mockState.nextError = undefined;
						return {
							withResponse: async () => {
								throw error;
							},
						};
					}
					const signal = (requestOptions as { signal?: AbortSignal } | undefined)?.signal;
					if (signal?.aborted) {
						const error = new Error("Request aborted");
						return {
							withResponse: async () => {
								throw error;
							},
						};
					}
					const response = mockState.nextResponse ?? {
						id: "img-1",
						usage: {
							prompt_tokens: 12,
							completion_tokens: 34,
							prompt_tokens_details: { cached_tokens: 0 },
						},
						choices: [
							{
								message: {
									content: "Here is your image.",
									images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }],
								},
							},
						],
					};
					mockState.nextResponse = undefined;
					const promise = Promise.resolve(response) as Promise<typeof response> & {
						withResponse: () => Promise<{
							data: typeof response;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: response,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openrouter images", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastRequestOptions = undefined;
		mockState.lastClientOptions = undefined;
		mockState.nextResponse = undefined;
		mockState.nextError = undefined;
	});

	it("returns text plus images in final output", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "google/gemini-3.1-flash-image-preview",
			name: "Gemini 3.1 Flash Image Preview",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["text", "image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
			headers: { "HTTP-Referer": "https://example.com" },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.stopReason).toBe("stop");
		expect(output.responseId).toBe("img-1");
		expect(output.output[0]).toMatchObject({ type: "text", text: "Here is your image." });
		expect(output.output[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "ZmFrZS1wbmc=" });

		const params = mockState.lastParams as {
			stream?: boolean;
			modalities?: string[];
			messages?: [{ content?: [{ type: string; text?: string }] }];
		};
		expect(params.stream).toBe(false);
		expect(params.modalities).toEqual(["image", "text"]);
		expect(params.messages?.[0]?.content?.[0]).toMatchObject({ type: "text", text: "Generate a dog" });
	});

	it("reports missing API keys before constructing a request", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "missing-provider",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};

		const output = await generateImages(model, { input: [{ type: "text", text: "Generate a dog" }] });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("No API key available for provider: missing-provider");
		expect(mockState.lastParams).toBeUndefined();
	});

	it("allows payload hooks and image input parts", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "google/gemini-3.1-flash-image-preview",
			name: "Gemini 3.1 Flash Image Preview",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};

		const output = await generateImages(
			model,
			{
				input: [
					{ type: "text", text: "Edit this" },
					{ type: "image", mimeType: "image/jpeg", data: "anBn" },
				],
			},
			{
				apiKey: "test",
				onPayload: (payload) => ({ ...(payload as Record<string, unknown>), metadata: { patched: true } }),
			},
		);

		expect(output.stopReason).toBe("stop");
		const params = mockState.lastParams as {
			metadata?: unknown;
			messages?: [{ content?: Array<{ type: string; text?: string; image_url?: { url: string } }> }];
		};
		expect(params.metadata).toEqual({ patched: true });
		expect(params.messages?.[0]?.content?.[0]).toEqual({ type: "text", text: "Edit this" });
		expect(params.messages?.[0]?.content?.[1]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,anBn" },
		});
	});

	it("passes request tuning options and merges provider headers", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0.001, cacheWrite: 0.002 },
			headers: { "X-Provider": "base" },
		};
		const controller = new AbortController();
		mockState.nextResponse = {
			id: "img-usage",
			usage: {
				prompt_tokens: 15,
				completion_tokens: 5,
				prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 4 },
			},
			choices: [
				{
					message: {
						content: "",
						images: [{ image_url: { url: "data:image/webp;base64,d2VicA==" } }],
					},
				},
			],
		};

		const output = await generateImages(
			model,
			{ input: [{ type: "text", text: "Generate a dog" }] },
			{
				apiKey: "test",
				headers: { "X-Request": "override" },
				signal: controller.signal,
				timeoutMs: 1234,
				maxRetries: 2,
				onPayload: (payload) => payload,
				onResponse: (response) => {
					expect(response.status).toBe(200);
				},
			},
		);

		expect(output.output).toEqual([{ type: "image", mimeType: "image/webp", data: "d2VicA==" }]);
		expect(output.usage).toMatchObject({ input: 9, output: 5, cacheRead: 2, cacheWrite: 4, totalTokens: 20 });
		expect(mockState.lastRequestOptions).toMatchObject({ signal: controller.signal, timeout: 1234, maxRetries: 2 });
		expect(mockState.lastClientOptions).toMatchObject({
			apiKey: "test",
			baseURL: "https://openrouter.ai/api/v1",
			defaultHeaders: { "X-Provider": "base", "X-Request": "override" },
		});
	});

	it("ignores empty choices and malformed image payloads", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};

		mockState.nextResponse = { id: "img-empty", choices: [] };
		const empty = await generateImages(model, { input: [{ type: "text", text: "Generate" }] }, { apiKey: "test" });

		mockState.nextResponse = {
			id: "img-malformed",
			usage: { prompt_tokens_details: {} },
			choices: [
				{
					message: {
						content: "",
						images: [
							{ image_url: "https://example.com/image.png" },
							{ image_url: "data:image/png,missing-base64" },
							{ image_url: {} },
						],
					},
				},
			],
		};
		const malformed = await generateImages(
			model,
			{ input: [{ type: "text", text: "Generate" }] },
			{ apiKey: "test" },
		);

		mockState.nextResponse = {
			id: "img-no-images",
			usage: { prompt_tokens_details: {} },
			choices: [{ message: { content: "" } }],
		};
		const noImages = await generateImages(model, { input: [{ type: "text", text: "Generate" }] }, { apiKey: "test" });

		expect(empty.output).toEqual([]);
		expect(malformed.output).toEqual([]);
		expect(noImages.output).toEqual([]);
		expect(noImages.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
	});

	it("passes through abort signal and returns aborted result", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};
		const controller = new AbortController();
		controller.abort();

		const output = await generateImages(model, context, { apiKey: "test", signal: controller.signal });
		expect(output.stopReason).toBe("aborted");
		expect(output.errorMessage).toBe("Request aborted");
		expect(mockState.lastRequestOptions).toMatchObject({ signal: controller.signal });
	});

	it("stringifies non-error request failures", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		mockState.nextError = { code: "bad_payload" };

		const output = await generateImages(model, { input: [{ type: "text", text: "Generate" }] }, { apiKey: "test" });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe('{"code":"bad_payload"}');
	});

	it("generateImages resolves the final assistant images result", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.output.some((item) => item.type === "image")).toBe(true);
	});
});
