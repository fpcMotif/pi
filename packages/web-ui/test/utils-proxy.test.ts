// ADR-0017 phase C.7: cover pi-web-ui/utils/proxy-utils.ts.
import { describe, expect, it, vi } from "vitest";

// Mock streamSimple via vi.hoisted so the mock fn exists at the time
// vi.mock executes (hoisted ABOVE all imports).
const { streamSimpleMock } = vi.hoisted(() => ({
	streamSimpleMock: vi.fn(async (model: unknown, _ctx: unknown, _opts: unknown) => ({ model })),
}));
vi.mock("@earendil-works/pi-ai", () => ({
	streamSimple: streamSimpleMock,
}));

import {
	applyProxyIfNeeded,
	createStreamFn,
	isCorsError,
	shouldUseProxyForProvider,
} from "../src/utils/proxy-utils.js";

describe("shouldUseProxyForProvider", () => {
	it("zai always requires proxy", () => {
		expect(shouldUseProxyForProvider("zai", "anything")).toBe(true);
		expect(shouldUseProxyForProvider("ZAI", "anything")).toBe(true);
	});

	it("anthropic OAuth tokens (sk-ant-oat-*) require proxy", () => {
		expect(shouldUseProxyForProvider("anthropic", "sk-ant-oat-XXX")).toBe(true);
	});

	it("anthropic JSON-string keys (starting with {) require proxy", () => {
		expect(shouldUseProxyForProvider("anthropic", "{credential:json}")).toBe(true);
	});

	it("anthropic API keys (sk-ant-api-*) do NOT require proxy", () => {
		expect(shouldUseProxyForProvider("anthropic", "sk-ant-api-XXX")).toBe(false);
	});

	it("openai-codex always requires proxy", () => {
		expect(shouldUseProxyForProvider("openai-codex", "anything")).toBe(true);
	});

	it.each(["openai", "google", "groq", "openrouter", "cerebras", "xai", "ollama", "lmstudio", "github-copilot"])(
		"%s never requires proxy",
		(provider) => {
			expect(shouldUseProxyForProvider(provider, "key")).toBe(false);
		},
	);

	it("unknown providers default to no-proxy", () => {
		expect(shouldUseProxyForProvider("brand-new-llm-co", "k")).toBe(false);
	});
});

const stubModel = (overrides: Partial<{ provider: string; baseUrl: string }> = {}): never =>
	({
		id: "x",
		name: "x",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
		...overrides,
	}) as never;

describe("applyProxyIfNeeded", () => {
	it("returns the original model when proxyUrl is undefined", () => {
		const m = stubModel({ provider: "zai" });
		expect(applyProxyIfNeeded(m, "k", undefined)).toBe(m);
	});

	it("returns the original model when model.baseUrl is empty", () => {
		const m = stubModel({ baseUrl: "" });
		expect(applyProxyIfNeeded(m, "k", "https://proxy.test")).toBe(m);
	});

	it("returns the original model when the provider+key doesn't need a proxy", () => {
		const m = stubModel({ provider: "openai" });
		expect(applyProxyIfNeeded(m, "sk-openai-key", "https://proxy.test")).toBe(m);
	});

	it("wraps baseUrl with the proxy URL when needed (zai)", () => {
		const m = stubModel({ provider: "zai", baseUrl: "https://zai.api/v1" });
		const result = applyProxyIfNeeded(m, "k", "https://proxy.test");
		expect((result as { baseUrl: string }).baseUrl).toBe("https://proxy.test/?url=https%3A%2F%2Fzai.api%2Fv1");
	});
});

describe("isCorsError", () => {
	it("returns false for non-Error values", () => {
		expect(isCorsError("just a string")).toBe(false);
		expect(isCorsError(null)).toBe(false);
		expect(isCorsError(undefined)).toBe(false);
		expect(isCorsError({ message: "looks like cors" })).toBe(false);
	});

	it("detects TypeError with 'Failed to fetch' message", () => {
		const e = new TypeError("Failed to fetch");
		expect(isCorsError(e)).toBe(true);
	});

	it("detects NetworkError by name", () => {
		const e = new Error("network down");
		e.name = "NetworkError";
		expect(isCorsError(e)).toBe(true);
	});

	it("detects 'cors' substring in message", () => {
		expect(isCorsError(new Error("CORS preflight failed"))).toBe(true);
	});

	it("detects 'cross-origin' substring in message", () => {
		expect(isCorsError(new Error("a Cross-Origin issue"))).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isCorsError(new Error("disk full"))).toBe(false);
	});
});

describe("createStreamFn", () => {
	it("delegates to streamSimple without proxy when apiKey is missing", async () => {
		const fn = createStreamFn(async () => "https://proxy.test");
		await fn(stubModel({ provider: "zai" }), { systemPrompt: "", messages: [] }, {});
		expect(streamSimpleMock).toHaveBeenCalled();
	});

	it("delegates without proxy when proxyUrl is undefined", async () => {
		const fn = createStreamFn(async () => undefined);
		await fn(stubModel({ provider: "zai" }), { systemPrompt: "", messages: [] }, { apiKey: "k" });
		expect(streamSimpleMock).toHaveBeenCalled();
	});

	it("applies proxy when both apiKey and proxyUrl are present and provider needs it", async () => {
		streamSimpleMock.mockClear();
		const fn = createStreamFn(async () => "https://proxy.test");
		await fn(stubModel({ provider: "zai" }), { systemPrompt: "", messages: [] }, { apiKey: "k" });
		const callArg = streamSimpleMock.mock.calls[0]![0] as { baseUrl: string };
		expect(callArg.baseUrl).toContain("https://proxy.test/?url=");
	});
});
