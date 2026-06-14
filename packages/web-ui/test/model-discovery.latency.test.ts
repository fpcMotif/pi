// model-discovery.latency.test.ts — REAL network-behaviour tests for
// src/utils/model-discovery.ts. Unlike model-discovery.test.ts (which mocks the
// `ollama/browser` module and stubs fetch with `{ ok, json }` literals + asserts
// vi.fn call counts), this file drives genuine end-to-end behaviour:
//
//   * The OpenAI-compatible HTTP providers (llama.cpp, vLLM) are exercised
//     through a real in-process fetch stub that returns *real* `Response`
//     objects — so the actual `response.ok` / `response.json()` /
//     status-text paths run for real.
//   * The Ollama provider is driven through the REAL `ollama/browser` SDK
//     (NOT mocked) sitting on top of the same fetch stub, so the real
//     SDK → HTTP → JSON-parse → mapping pipeline is validated.
//   * Timing/latency is asserted with a real (un-faked) clock: a slow endpoint
//     must make the returned promise resolve only after the network delay, and
//     Ollama's per-model `show()` fan-out must run concurrently (total time ≈
//     one round-trip, not N round-trips).
//   * Abort/reject paths feed a fetch that throws an AbortError / TypeError the
//     way a real browser fetch does on a dropped connection.
//
// Only the network boundary (global `fetch`) and the LM-Studio WebSocket SDK are
// stubbed — everything else is the real implementation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	discoverLlamaCppModels,
	discoverModels,
	discoverOllamaModels,
	discoverVLLMModels,
} from "../src/utils/model-discovery.js";

// ---------------------------------------------------------------------------
// In-process fetch stub helpers
// ---------------------------------------------------------------------------

type Handler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

interface FetchLog {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const calls: FetchLog[] = [];

/** Install a routing fetch stub that records every request and dispatches to `handler`. */
function installFetch(handler: Handler): void {
	(globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
		const headers: Record<string, string> = {};
		const h = init?.headers as Record<string, string> | undefined;
		if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
		let body: unknown;
		if (typeof init?.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		calls.push({ url, method: init?.method ?? "GET", headers, body });
		return handler(url, init);
	};
}

/** A real Response carrying JSON, optionally delayed by `delayMs` before resolving. */
function jsonResponse(payload: unknown, opts: { status?: number; delayMs?: number } = {}): Promise<Response> {
	const status = opts.status ?? 200;
	const make = () =>
		new Response(JSON.stringify(payload), {
			status,
			statusText: status === 200 ? "OK" : "ERR",
			headers: { "content-type": "application/json" },
		});
	if (!opts.delayMs) return Promise.resolve(make());
	return new Promise((resolve) => setTimeout(() => resolve(make()), opts.delayMs));
}

/** Ollama dual-endpoint router: GET /api/tags -> list, POST /api/show -> per-model details. */
function installOllamaFetch(
	models: Array<{ name: string }>,
	showFor: (model: string) => { payload: unknown; status?: number; delayMs?: number },
): void {
	installFetch((url, init) => {
		if (url.endsWith("/api/tags")) {
			return jsonResponse({ models });
		}
		if (url.endsWith("/api/show")) {
			const requested = JSON.parse(String(init?.body ?? "{}")).model as string;
			const { payload, status, delayMs } = showFor(requested);
			return jsonResponse(payload, { status, delayMs });
		}
		return jsonResponse({}, { status: 404 });
	});
}

beforeEach(() => {
	calls.length = 0;
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).fetch;
});

// ===========================================================================
// llama.cpp — real Response objects through the real fetch path
// ===========================================================================
describe("discoverLlamaCppModels (real Response/fetch)", () => {
	it("parses a real multi-model JSON Response, preserving order and per-model context", async () => {
		installFetch(() =>
			jsonResponse({
				data: [
					{ id: "qwen2.5-coder", context_length: 32768, max_tokens: 8192 },
					{ id: "phi-4", context_length: 16384 },
					{ id: "tiny" },
				],
			}),
		);

		const models = await discoverLlamaCppModels("http://localhost:8080", "sk-local");

		expect(models.map((m) => m.id)).toEqual(["qwen2.5-coder", "phi-4", "tiny"]);
		// per-model context window honoured / defaulted independently
		expect(models[0].contextWindow).toBe(32768);
		expect(models[0].maxTokens).toBe(8192);
		expect(models[1].contextWindow).toBe(16384);
		expect(models[1].maxTokens).toBe(4096); // default when max_tokens absent
		expect(models[2].contextWindow).toBe(8192); // default when context_length absent
		expect(models[2].maxTokens).toBe(4096);
		// shared shape: completions API, derived /v1 baseUrl, zero cost, text input
		for (const m of models) {
			expect(m.api).toBe("openai-completions");
			expect(m.baseUrl).toBe("http://localhost:8080/v1");
			expect(m.provider).toBe("");
			expect(m.reasoning).toBe(false);
			expect(m.input).toEqual(["text"]);
			expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}

		// real request: GET /v1/models with the bearer auth header actually sent
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://localhost:8080/v1/models");
		expect(calls[0].method).toBe("GET");
		expect(calls[0].headers.authorization).toBe("Bearer sk-local");
		expect(calls[0].headers["content-type"]).toBe("application/json");
	});

	it("returns an empty array (not an error) for an empty real Response body", async () => {
		installFetch(() => jsonResponse({ data: [] }));
		await expect(discoverLlamaCppModels("http://localhost:8080")).resolves.toEqual([]);
		expect(calls[0].headers.authorization).toBeUndefined();
	});

	it("surfaces a real HTTP 503 (status + statusText) as a discovery error", async () => {
		installFetch(() => new Response("upstream unavailable", { status: 503, statusText: "Service Unavailable" }));
		await expect(discoverLlamaCppModels("http://localhost:8080")).rejects.toThrow(
			/llama\.cpp discovery failed: HTTP 503: Service Unavailable/,
		);
	});

	it("rejects when the server returns a 200 with a truncated/invalid JSON body (real parse failure)", async () => {
		// A real upstream returning a 200 with a malformed JSON body — response.json() throws.
		installFetch(() => new Response('{"data": [', { status: 200, headers: { "content-type": "application/json" } }));
		await expect(discoverLlamaCppModels("http://localhost:8080")).rejects.toThrow(/llama\.cpp discovery failed/);
	});

	it("rejects when JSON is well-formed but `data` is not an array", async () => {
		installFetch(() => jsonResponse({ data: { id: "oops" } }));
		await expect(discoverLlamaCppModels("http://localhost:8080")).rejects.toThrow(/Invalid response format/);
	});

	it("LATENCY: a slow server delays resolution by ~the network round-trip", async () => {
		const DELAY = 120;
		installFetch(() => jsonResponse({ data: [{ id: "slow-model" }] }, { delayMs: DELAY }));

		const start = performance.now();
		const models = await discoverLlamaCppModels("http://localhost:8080");
		const elapsed = performance.now() - start;

		expect(models[0].id).toBe("slow-model");
		// Must not resolve before the wire delay (allow small scheduler slack).
		expect(elapsed).toBeGreaterThanOrEqual(DELAY - 25);
		// And it shouldn't take wildly longer than the single round-trip.
		expect(elapsed).toBeLessThan(DELAY + 400);
	});

	it("LATENCY: a body delivered after a slow round-trip is still parsed correctly", async () => {
		const DELAY = 80;
		installFetch(() =>
			jsonResponse({ data: [{ id: "streamed-a", context_length: 4096 }, { id: "streamed-b" }] }, { delayMs: DELAY }),
		);

		const start = performance.now();
		const models = await discoverLlamaCppModels("http://localhost:8080");
		const elapsed = performance.now() - start;

		expect(models.map((m) => m.id)).toEqual(["streamed-a", "streamed-b"]);
		expect(models[0].contextWindow).toBe(4096);
		expect(elapsed).toBeGreaterThanOrEqual(DELAY - 25);
	});

	it("propagates a network-level fetch rejection (dropped connection) as a discovery error", async () => {
		installFetch(() => {
			throw new TypeError("Failed to fetch");
		});
		await expect(discoverLlamaCppModels("http://localhost:8080")).rejects.toThrow(
			/llama\.cpp discovery failed: Failed to fetch/,
		);
	});

	it("propagates an aborted request (AbortError) as a discovery error", async () => {
		installFetch(() => {
			const err = new DOMException("The operation was aborted.", "AbortError");
			return Promise.reject(err);
		});
		await expect(discoverLlamaCppModels("http://localhost:8080")).rejects.toThrow(/The operation was aborted/);
	});
});

// ===========================================================================
// vLLM — max_model_len semantics + maxTokens cap through real fetch
// ===========================================================================
describe("discoverVLLMModels (real Response/fetch)", () => {
	it("uses max_model_len as context window and caps maxTokens at min(context, 4096)", async () => {
		installFetch(() =>
			jsonResponse({
				data: [
					{ id: "big-ctx", max_model_len: 131072 }, // huge -> capped to 4096
					{ id: "small-ctx", max_model_len: 2048 }, // smaller than cap -> stays 2048
				],
			}),
		);

		const models = await discoverVLLMModels("http://localhost:8000", "vllm-key");

		expect(models[0].contextWindow).toBe(131072);
		expect(models[0].maxTokens).toBe(4096); // Math.min(131072, 4096)
		expect(models[1].contextWindow).toBe(2048);
		expect(models[1].maxTokens).toBe(2048); // Math.min(2048, 4096)
		for (const m of models) expect(m.baseUrl).toBe("http://localhost:8000/v1");

		expect(calls[0].url).toBe("http://localhost:8000/v1/models");
		expect(calls[0].headers.authorization).toBe("Bearer vllm-key");
	});

	it("surfaces a real HTTP 401 as a discovery error", async () => {
		installFetch(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
		await expect(discoverVLLMModels("http://localhost:8000")).rejects.toThrow(
			/vLLM discovery failed: HTTP 401: Unauthorized/,
		);
	});

	it("LATENCY: resolves only after the slow vLLM round-trip completes", async () => {
		const DELAY = 100;
		installFetch(() => jsonResponse({ data: [{ id: "m", max_model_len: 8192 }] }, { delayMs: DELAY }));
		const start = performance.now();
		const models = await discoverVLLMModels("http://localhost:8000");
		const elapsed = performance.now() - start;
		expect(models[0].maxTokens).toBe(4096);
		expect(elapsed).toBeGreaterThanOrEqual(DELAY - 25);
	});
});

// ===========================================================================
// Ollama — driven through the REAL ollama/browser SDK + real fetch stub
// ===========================================================================
describe("discoverOllamaModels (real ollama SDK over real fetch)", () => {
	it("lists models, fetches per-model details, filters non-tool models, and maps fields", async () => {
		installOllamaFetch([{ name: "llama3:8b" }, { name: "embed-only" }, { name: "qwen2.5:7b" }], (model) => {
			if (model === "llama3:8b") {
				return {
					payload: {
						capabilities: ["completion", "tools", "thinking"],
						model_info: { "general.architecture": "llama", "llama.context_length": "16384" },
					},
				};
			}
			if (model === "qwen2.5:7b") {
				return {
					payload: {
						capabilities: ["tools"],
						model_info: { "general.architecture": "qwen2", "qwen2.context_length": "32768" },
					},
				};
			}
			// embed-only: no "tools" capability -> filtered out
			return { payload: { capabilities: ["embedding"], model_info: {} } };
		});

		const models = await discoverOllamaModels("http://localhost:11434");

		// Two tool-capable models survive; the embedding model is dropped.
		const byId = Object.fromEntries(models.map((m) => [m.id, m]));
		expect(Object.keys(byId).sort()).toEqual(["llama3:8b", "qwen2.5:7b"]);

		expect(byId["llama3:8b"].contextWindow).toBe(16384);
		expect(byId["llama3:8b"].maxTokens).toBe(163840); // 10x
		expect(byId["llama3:8b"].reasoning).toBe(true); // has "thinking"
		expect(byId["llama3:8b"].baseUrl).toBe("http://localhost:11434/v1");

		expect(byId["qwen2.5:7b"].contextWindow).toBe(32768);
		expect(byId["qwen2.5:7b"].reasoning).toBe(false); // no "thinking"

		// Real requests: 1 GET /api/tags + one POST /api/show per listed model.
		const tags = calls.filter((c) => c.url.endsWith("/api/tags"));
		const shows = calls.filter((c) => c.url.endsWith("/api/show"));
		expect(tags).toHaveLength(1);
		expect(shows).toHaveLength(3);
		expect(shows.every((c) => c.method === "POST")).toBe(true);
		expect(shows.map((c) => (c.body as { model: string }).model).sort()).toEqual([
			"embed-only",
			"llama3:8b",
			"qwen2.5:7b",
		]);
	});

	it("returns an empty array when the Ollama server has no models", async () => {
		installOllamaFetch([], () => ({ payload: {} }));
		await expect(discoverOllamaModels("http://localhost:11434")).resolves.toEqual([]);
		expect(calls.filter((c) => c.url.endsWith("/api/show"))).toHaveLength(0);
	});

	it("drops a model whose show() returns a real HTTP error, keeping the healthy one", async () => {
		installOllamaFetch([{ name: "good" }, { name: "broken" }], (model) => {
			if (model === "broken") return { payload: { error: "model not found" }, status: 500 };
			return { payload: { capabilities: ["tools"], model_info: {} } };
		});
		const models = await discoverOllamaModels("http://localhost:11434");
		expect(models.map((m) => m.id)).toEqual(["good"]);
		expect(models[0].contextWindow).toBe(8192); // default
	});

	it("throws a descriptive error when the listing endpoint is unreachable", async () => {
		installFetch(() => {
			throw new TypeError("Failed to fetch");
		});
		await expect(discoverOllamaModels("http://localhost:11434")).rejects.toThrow(/Ollama discovery failed/);
	});

	it("LATENCY: per-model show() calls run concurrently, not serially", async () => {
		// 6 models, each show() gated behind the same 60ms delay. If the
		// implementation awaited them serially the total would be ~360ms; the
		// real Promise.all fan-out keeps it close to a single round-trip.
		const SHOW_DELAY = 60;
		const N = 6;
		const names = Array.from({ length: N }, (_, i) => ({ name: `m${i}` }));
		installOllamaFetch(names, () => ({
			payload: { capabilities: ["tools"], model_info: {} },
			delayMs: SHOW_DELAY,
		}));

		const start = performance.now();
		const models = await discoverOllamaModels("http://localhost:11434");
		const elapsed = performance.now() - start;

		expect(models).toHaveLength(N);
		// Concurrent: well under the serial lower bound of N * delay.
		expect(elapsed).toBeLessThan(SHOW_DELAY * N * 0.6);
		// But it still had to wait for at least one round-trip.
		expect(elapsed).toBeGreaterThanOrEqual(SHOW_DELAY - 25);
	});
});

// ===========================================================================
// discoverModels dispatch — real underlying providers
// ===========================================================================
describe("discoverModels dispatch (real providers)", () => {
	it("routes 'llama.cpp' through the real llama.cpp path", async () => {
		installFetch(() => jsonResponse({ data: [{ id: "dispatched-lc", context_length: 4096 }] }));
		const models = await discoverModels("llama.cpp", "http://localhost:8080");
		expect(models[0].id).toBe("dispatched-lc");
		expect(models[0].contextWindow).toBe(4096);
		expect(calls[0].url).toBe("http://localhost:8080/v1/models");
	});

	it("routes 'vllm' through the real vLLM path", async () => {
		installFetch(() => jsonResponse({ data: [{ id: "dispatched-vl", max_model_len: 200000 }] }));
		const models = await discoverModels("vllm", "http://localhost:8000");
		expect(models[0].id).toBe("dispatched-vl");
		expect(models[0].maxTokens).toBe(4096); // capped
	});

	it("routes 'ollama' through the real ollama SDK path and forwards the apiKey arg", async () => {
		installOllamaFetch([{ name: "routed" }], () => ({ payload: { capabilities: ["tools"], model_info: {} } }));
		const models = await discoverModels("ollama", "http://localhost:11434", "ignored-by-ollama");
		expect(models.map((m) => m.id)).toEqual(["routed"]);
	});
});
