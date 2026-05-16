// ADR-0017 phase C.7: model-discovery.ts — provider model discovery. Mocks
// the ollama + LM Studio SDKs and stubs global fetch for the OpenAI-compatible
// HTTP providers (llama.cpp, vLLM). Every branch in every discovery function
// plus the dispatch in discoverModels is exercised.
//
// The SDK mocks read their behaviour from `ollamaState` / `lmStudioState`
// configured *before* each call, because discoverOllamaModels invokes
// `ollama.list()` synchronously inside its async body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ollamaState, lmStudioState } = vi.hoisted(() => ({
	ollamaState: {
		list: async (): Promise<unknown> => ({ models: [] }),
		show: async (_args: { model: string }): Promise<unknown> => ({ capabilities: [], model_info: {} }),
	},
	lmStudioState: {
		listDownloadedModels: async (): Promise<unknown[]> => [],
	},
}));

vi.mock("ollama/browser", () => ({
	Ollama: class {
		list() {
			return ollamaState.list();
		}
		show(args: { model: string }) {
			return ollamaState.show(args);
		}
	},
}));

vi.mock("@lmstudio/sdk", () => ({
	LMStudioClient: class {
		system = { listDownloadedModels: () => lmStudioState.listDownloadedModels() };
	},
}));

import {
	discoverLlamaCppModels,
	discoverLMStudioModels,
	discoverModels,
	discoverOllamaModels,
	discoverVLLMModels,
} from "../src/utils/model-discovery.js";

beforeEach(() => {
	ollamaState.list = async () => ({ models: [] });
	ollamaState.show = async () => ({ capabilities: [], model_info: {} });
	lmStudioState.listDownloadedModels = async () => [];
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).fetch;
});

describe("discoverOllamaModels", () => {
	it("returns tool-capable models with architecture-derived context window + thinking flag", async () => {
		ollamaState.list = async () => ({ models: [{ name: "llama3" }, { name: "no-tools" }] });
		ollamaState.show = async ({ model }) => {
			if (model === "llama3") {
				return {
					capabilities: ["tools", "thinking"],
					model_info: { "general.architecture": "llama", "llama.context_length": "4096" },
				};
			}
			return { capabilities: ["completion"], model_info: {} };
		};
		const result = await discoverOllamaModels("http://localhost:11434");
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("llama3");
		expect(result[0].reasoning).toBe(true);
		expect(result[0].contextWindow).toBe(4096);
		expect(result[0].maxTokens).toBe(40960); // 10x context
		expect(result[0].baseUrl).toBe("http://localhost:11434/v1");
	});

	it("defaults context window to 8192 when model_info lacks the architecture key", async () => {
		ollamaState.list = async () => ({ models: [{ name: "m" }] });
		ollamaState.show = async () => ({ capabilities: ["tools"], model_info: {} });
		const out = await discoverOllamaModels("http://h");
		expect(out[0].contextWindow).toBe(8192);
		expect(out[0].reasoning).toBe(false);
	});

	it("skips models that do not support tools (capabilities filter → null → filtered)", async () => {
		ollamaState.list = async () => ({ models: [{ name: "chat-only" }] });
		ollamaState.show = async () => ({ capabilities: ["completion"], model_info: {} });
		expect(await discoverOllamaModels("http://h")).toEqual([]);
	});

	it("a per-model show() failure yields null and is filtered out", async () => {
		ollamaState.list = async () => ({ models: [{ name: "boom" }] });
		ollamaState.show = async () => {
			throw new Error("show failed");
		};
		expect(await discoverOllamaModels("http://h")).toEqual([]);
	});

	it("throws a descriptive error when ollama.list() fails", async () => {
		ollamaState.list = async () => {
			throw new Error("connection refused");
		};
		await expect(discoverOllamaModels("http://h")).rejects.toThrow(/Ollama discovery failed: connection refused/);
	});

	it("wraps a non-Error rejection with String() in the message", async () => {
		ollamaState.list = async () => {
			throw "raw string failure";
		};
		await expect(discoverOllamaModels("http://h")).rejects.toThrow(/raw string failure/);
	});
});

describe("discoverLlamaCppModels", () => {
	it("maps /v1/models data and uses provided context_length / max_tokens + sends auth header", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "qwen", context_length: 16384, max_tokens: 2048 }] }),
		}));
		const out = await discoverLlamaCppModels("http://localhost:8080", "secret-key");
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("qwen");
		expect(out[0].contextWindow).toBe(16384);
		expect(out[0].maxTokens).toBe(2048);
		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer secret-key");
	});

	it("falls back to defaults when context_length / max_tokens are absent (no auth header)", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "m" }] }),
		}));
		const out = await discoverLlamaCppModels("http://h");
		expect(out[0].contextWindow).toBe(8192);
		expect(out[0].maxTokens).toBe(4096);
		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBeUndefined();
	});

	it("throws when the HTTP response is not ok", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
		}));
		await expect(discoverLlamaCppModels("http://h")).rejects.toThrow(/llama\.cpp discovery failed/);
	});

	it("throws when the response shape is invalid (no data array)", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ notData: true }),
		}));
		await expect(discoverLlamaCppModels("http://h")).rejects.toThrow(/Invalid response format/);
	});
});

describe("discoverVLLMModels", () => {
	it("maps /v1/models data using max_model_len and caps maxTokens at 4096 + sends auth header", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "big", max_model_len: 100000 }] }),
		}));
		const out = await discoverVLLMModels("http://localhost:8000", "k");
		expect(out[0].contextWindow).toBe(100000);
		expect(out[0].maxTokens).toBe(4096); // capped
		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer k");
	});

	it("uses the 8192 default when max_model_len is missing (capped to context)", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "m" }] }),
		}));
		const out = await discoverVLLMModels("http://h");
		expect(out[0].contextWindow).toBe(8192);
		expect(out[0].maxTokens).toBe(4096);
	});

	it("sends no Authorization header when apiKey is omitted", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [] }),
		}));
		await discoverVLLMModels("http://h");
		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBeUndefined();
	});

	it("throws on a non-ok response", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: false,
			status: 404,
			statusText: "Not Found",
		}));
		await expect(discoverVLLMModels("http://h")).rejects.toThrow(/vLLM discovery failed/);
	});

	it("throws on an invalid response shape", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({}),
		}));
		await expect(discoverVLLMModels("http://h")).rejects.toThrow(/Invalid response format/);
	});
});

describe("discoverLMStudioModels", () => {
	it("filters to llm-type models and maps fields (vision + tool use)", async () => {
		lmStudioState.listDownloadedModels = async () => [
			{
				type: "llm",
				path: "lmstudio/qwen",
				displayName: "Qwen",
				maxContextLength: 8192,
				trainedForToolUse: true,
				vision: true,
			},
			{ type: "embedding", path: "emb" },
		];
		const out = await discoverLMStudioModels("http://localhost:1234");
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("lmstudio/qwen");
		expect(out[0].name).toBe("Qwen");
		expect(out[0].reasoning).toBe(true);
		expect(out[0].input).toEqual(["text", "image"]);
	});

	it("falls back to path for name and defaults reasoning/input when fields are absent", async () => {
		lmStudioState.listDownloadedModels = async () => [{ type: "llm", path: "model-x", maxContextLength: 2048 }];
		const out = await discoverLMStudioModels("http://localhost:1234");
		expect(out[0].name).toBe("model-x");
		expect(out[0].reasoning).toBe(false);
		expect(out[0].input).toEqual(["text"]);
	});

	it("uses the default port 1234 when the baseUrl has no port", async () => {
		lmStudioState.listDownloadedModels = async () => [];
		const out = await discoverLMStudioModels("http://localhost");
		expect(out).toEqual([]);
	});

	it("throws a descriptive error when the SDK call fails", async () => {
		lmStudioState.listDownloadedModels = async () => {
			throw new Error("ws closed");
		};
		await expect(discoverLMStudioModels("http://localhost:1234")).rejects.toThrow(/LM Studio discovery failed/);
	});
});

describe("discoverModels dispatch", () => {
	it("routes 'llama.cpp' to discoverLlamaCppModels", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "lc" }] }),
		}));
		expect((await discoverModels("llama.cpp", "http://h"))[0].id).toBe("lc");
	});

	it("routes 'vllm' to discoverVLLMModels", async () => {
		(globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "vl" }] }),
		}));
		expect((await discoverModels("vllm", "http://h"))[0].id).toBe("vl");
	});

	it("routes 'ollama' to discoverOllamaModels", async () => {
		ollamaState.list = async () => ({ models: [] });
		expect(await discoverModels("ollama", "http://h")).toEqual([]);
	});

	it("routes 'lmstudio' to discoverLMStudioModels", async () => {
		lmStudioState.listDownloadedModels = async () => [];
		expect(await discoverModels("lmstudio", "http://localhost:1234")).toEqual([]);
	});
});
