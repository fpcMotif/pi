import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model } from "../src/types.js";

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface TextPart {
	type: "text";
	text: string;
	cache_control?: CacheControl;
}

interface ToolWithCacheControl {
	type: string;
	cache_control?: CacheControl;
}

interface CapturedParams {
	messages: Array<{
		role: string;
		content: string | TextPart[] | null;
	}>;
	tools?: ToolWithCacheControl[];
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

async function capturePayload(
	model: Model<"openai-completions">,
	options?: { cacheRetention?: "none" | "short" | "long" },
): Promise<CapturedParams> {
	const timestamp = Date.now();

	await streamOpenAICompletions(
		model,
		{
			systemPrompt: "System prompt",
			messages: [{ role: "user", content: "Hello", timestamp }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object({
						path: Type.String(),
					}),
				},
			],
		},
		{ apiKey: "test-key", ...options },
	).result();

	if (!mockState.lastParams) {
		throw new Error("Expected payload to be captured");
	}

	return mockState.lastParams;
}

async function captureCustomPayload(
	model: Model<"openai-completions">,
	context: Parameters<typeof streamOpenAICompletions>[1],
	options?: { cacheRetention?: "none" | "short" | "long" },
): Promise<CapturedParams> {
	await streamOpenAICompletions(model, context, { apiKey: "test-key", ...options }).result();

	if (!mockState.lastParams) {
		throw new Error("Expected payload to be captured");
	}

	return mockState.lastParams;
}

function getInstructionMessage(params: CapturedParams) {
	return params.messages.find((message) => message.role === "system" || message.role === "developer");
}

function expectAnthropicCacheMarkers(params: CapturedParams): void {
	const instructionMessage = getInstructionMessage(params);
	expect(instructionMessage).toBeDefined();
	expect(Array.isArray(instructionMessage?.content)).toBe(true);
	expect((instructionMessage?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

	expect(params.tools).toHaveLength(1);
	expect(params.tools?.[0]?.cache_control).toEqual({ type: "ephemeral" });

	const lastMessage = params.messages[params.messages.length - 1];
	expect(lastMessage.role).toBe("user");
	expect(Array.isArray(lastMessage.content)).toBe(true);
	expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
}

describe("openai-completions cacheControlFormat", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("applies Anthropic-style cache markers when model compat enables them", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-qwen",
			name: "Custom Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
			},
		};

		const params = await capturePayload(model);
		expectAnthropicCacheMarkers(params);
	});

	it("preserves Anthropic-style cache markers for OpenRouter Anthropic models", async () => {
		const model = getModel("openrouter", "anthropic/claude-sonnet-4");
		const params = await capturePayload(model);
		expectAnthropicCacheMarkers(params);
	});

	it("omits Anthropic-style cache markers when cacheRetention is none", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-qwen",
			name: "Custom Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
			},
		};
		const params = await capturePayload(model, { cacheRetention: "none" });
		const instructionMessage = getInstructionMessage(params);

		expect(Array.isArray(instructionMessage?.content)).toBe(false);
		expect(params.tools?.[0]?.cache_control).toBeUndefined();
		expect(typeof params.messages[params.messages.length - 1]?.content).toBe("string");
	});

	it("does not add cache markers when replay history has no text part to mark", async () => {
		const baseModel: Model<"openai-completions"> = {
			id: "custom-qwen",
			name: "Custom Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
			},
		};

		const toolHistory = await captureCustomPayload(baseModel, {
			messages: [
				{
					role: "assistant",
					api: "openai-completions",
					provider: "openrouter",
					model: "custom-qwen",
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
			],
		});
		expect(toolHistory.tools).toEqual([]);
		expect(toolHistory.messages[0]).toMatchObject({ role: "assistant", content: null });

		const emptyAssistant = await captureCustomPayload(
			{
				...baseModel,
				compat: { cacheControlFormat: "anthropic", requiresAssistantAfterToolResult: true },
			},
			{
				messages: [
					{
						role: "assistant",
						api: "openai-completions",
						provider: "openrouter",
						model: "custom-qwen",
						content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "README.md" } }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 1,
					},
				],
			},
		);
		expect(emptyAssistant.messages[0]).toMatchObject({ role: "assistant", content: "" });

		const imageOnly = await captureCustomPayload(baseModel, {
			messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "abcd" }], timestamp: 1 }],
		});
		expect(imageOnly.messages[0]).toEqual({
			role: "user",
			content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abcd" } }],
		});
	});
});
