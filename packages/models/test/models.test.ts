// ADR-0017 phase C.6: 100% coverage on packages/models/src/**.
// TDD-style: each test asserts a specific behavior of the registry surface.
import { describe, expect, it } from "vitest";
import {
	calculateCost,
	clampThinkingLevel,
	getImageModel,
	getImageModels,
	getImageProviders,
	getModel,
	getModels,
	getProviders,
	getSupportedThinkingLevels,
	IMAGE_MODELS,
	MODELS,
	modelsAreEqual,
} from "../src/index.js";
import type { Model, ModelThinkingLevel, Usage } from "../src/types.js";

const makeUsage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const makeFakeModel = (overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> => ({
	id: "fake-model",
	name: "Fake",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
	contextWindow: 8192,
	maxTokens: 4096,
	...overrides,
});

describe("MODELS / IMAGE_MODELS registries", () => {
	it("MODELS exports a non-empty object keyed by provider", () => {
		expect(typeof MODELS).toBe("object");
		expect(Object.keys(MODELS).length).toBeGreaterThan(0);
	});

	it("IMAGE_MODELS exports a non-empty object keyed by provider", () => {
		expect(typeof IMAGE_MODELS).toBe("object");
		expect(Object.keys(IMAGE_MODELS).length).toBeGreaterThan(0);
	});

	it("every model in MODELS has the required Model<TApi> shape", () => {
		for (const [provider, models] of Object.entries(MODELS)) {
			for (const [id, model] of Object.entries(models)) {
				expect(model.id).toBe(id);
				expect(model.provider).toBe(provider);
				expect(typeof model.name).toBe("string");
				expect(typeof model.api).toBe("string");
				expect(typeof model.baseUrl).toBe("string");
				expect(typeof model.reasoning).toBe("boolean");
				expect(Array.isArray(model.input)).toBe(true);
				expect(typeof model.cost.input).toBe("number");
				expect(typeof model.contextWindow).toBe("number");
				expect(typeof model.maxTokens).toBe("number");
			}
		}
	});

	it("every image model in IMAGE_MODELS has the required ImagesModel shape", () => {
		for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
			for (const [id, model] of Object.entries(models)) {
				expect(model.id).toBe(id);
				expect(model.provider).toBe(provider);
				expect(Array.isArray(model.output)).toBe(true);
			}
		}
	});
});

describe("getProviders", () => {
	it("returns every provider key in MODELS", () => {
		const providers = getProviders();
		expect(providers.sort()).toEqual(Object.keys(MODELS).sort());
	});

	it("only narrowed providers per ADR-0003 (openai, openai-codex, openrouter)", () => {
		const expected = new Set(["openai", "openai-codex", "openrouter"]);
		for (const provider of getProviders()) {
			expect(expected.has(provider)).toBe(true);
		}
	});
});

describe("getModel", () => {
	it("returns a registered model by (provider, modelId)", () => {
		const providers = getProviders();
		expect(providers.length).toBeGreaterThan(0);
		const provider = providers[0]!;
		const modelIds = Object.keys(MODELS[provider as keyof typeof MODELS]);
		expect(modelIds.length).toBeGreaterThan(0);
		const modelId = modelIds[0]!;
		const model = getModel(provider as "openai", modelId as never);
		expect(model).toBeDefined();
		expect(model.id).toBe(modelId);
		expect(model.provider).toBe(provider);
	});

	it("returns undefined-as-Model for an unknown provider (typed access only)", () => {
		// runtime path: unknown provider → providerModels is undefined → ?.get(...) is undefined.
		// The function's TS signature requires KnownProvider, so we cast to bypass for the runtime test.
		const result = getModel("nope" as "openai", "anything" as never);
		expect(result).toBeUndefined();
	});

	it("returns undefined-as-Model for an unknown modelId within a real provider", () => {
		const result = getModel("openai" as const, "not-a-real-model" as never);
		expect(result).toBeUndefined();
	});
});

describe("getModels", () => {
	it("returns every model registered under a known provider", () => {
		const providers = getProviders();
		const provider = providers[0]!;
		const models = getModels(provider as "openai");
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) expect(m.provider).toBe(provider);
	});

	it("returns [] for an unknown provider", () => {
		const result = getModels("nope" as "openai");
		expect(result).toEqual([]);
	});
});

describe("getImageProviders / getImageModel / getImageModels", () => {
	it("getImageProviders returns every key in IMAGE_MODELS", () => {
		const providers = getImageProviders();
		expect(providers.sort()).toEqual(Object.keys(IMAGE_MODELS).sort());
	});

	it("getImageModels returns every image model under a known provider", () => {
		const providers = getImageProviders();
		expect(providers.length).toBeGreaterThan(0);
		const provider = providers[0]!;
		const models = getImageModels(provider as "openrouter");
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) expect(m.provider).toBe(provider);
	});

	it("getImageModels returns [] for an unknown provider", () => {
		const result = getImageModels("nope" as "openrouter");
		expect(result).toEqual([]);
	});

	it("getImageModel returns a registered model and undefined-as-Model otherwise", () => {
		const providers = getImageProviders();
		const provider = providers[0]!;
		const modelIds = Object.keys(IMAGE_MODELS[provider as keyof typeof IMAGE_MODELS]);
		expect(modelIds.length).toBeGreaterThan(0);
		const modelId = modelIds[0]!;
		const found = getImageModel(provider as "openrouter", modelId as never);
		expect(found).toBeDefined();
		expect(found.id).toBe(modelId);

		const missing = getImageModel(provider as "openrouter", "not-a-real-image-model" as never);
		expect(missing).toBeUndefined();
		const missingProvider = getImageModel("nope" as "openrouter", "anything" as never);
		expect(missingProvider).toBeUndefined();
	});
});

describe("calculateCost", () => {
	it("computes per-token cost = (per-million-rate / 1_000_000) × tokens for each category", () => {
		const model = makeFakeModel({ cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 } });
		const usage = makeUsage(1_000_000, 500_000, 200_000, 100_000);
		const cost = calculateCost(model, usage);
		expect(cost.input).toBeCloseTo(10);
		expect(cost.output).toBeCloseTo(10);
		expect(cost.cacheRead).toBeCloseTo(0.2);
		expect(cost.cacheWrite).toBeCloseTo(0.2);
		expect(cost.total).toBeCloseTo(20.4);
	});

	it("zeros all categories when usage is zero", () => {
		const model = makeFakeModel();
		const usage = makeUsage(0, 0, 0, 0);
		const cost = calculateCost(model, usage);
		expect(cost.input).toBe(0);
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
		expect(cost.total).toBe(0);
	});

	it("mutates usage.cost in place AND returns it (same reference)", () => {
		const model = makeFakeModel();
		const usage = makeUsage(100, 100);
		const returned = calculateCost(model, usage);
		expect(returned).toBe(usage.cost);
	});
});

describe("getSupportedThinkingLevels", () => {
	it("returns ['off'] when model.reasoning is false (regardless of map contents)", () => {
		const model = makeFakeModel({
			reasoning: false,
			thinkingLevelMap: { off: null, low: "anything" },
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
	});

	it("with reasoning=true and no thinkingLevelMap, returns all base levels but excludes xhigh", () => {
		const model = makeFakeModel({ reasoning: true });
		const levels = getSupportedThinkingLevels(model);
		expect(levels).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(levels.includes("xhigh")).toBe(false);
	});

	it("xhigh is included iff thinkingLevelMap.xhigh is defined (not null)", () => {
		const model = makeFakeModel({ reasoning: true, thinkingLevelMap: { xhigh: "very-high" } });
		expect(getSupportedThinkingLevels(model).includes("xhigh")).toBe(true);
	});

	it("xhigh is excluded when thinkingLevelMap.xhigh === null", () => {
		const model = makeFakeModel({ reasoning: true, thinkingLevelMap: { xhigh: null } });
		expect(getSupportedThinkingLevels(model).includes("xhigh")).toBe(false);
	});

	it("any base level explicitly set to null is filtered out", () => {
		const model = makeFakeModel({ reasoning: true, thinkingLevelMap: { medium: null } });
		const levels = getSupportedThinkingLevels(model);
		expect(levels.includes("medium")).toBe(false);
		expect(levels.includes("low")).toBe(true);
	});
});

describe("clampThinkingLevel", () => {
	it("returns the requested level as-is when it's supported", () => {
		const model = makeFakeModel({ reasoning: true });
		expect(clampThinkingLevel(model, "medium")).toBe("medium");
	});

	it("forward-scans to the next higher supported level when requested is unsupported", () => {
		const model = makeFakeModel({ reasoning: true, thinkingLevelMap: { low: null, medium: null } });
		// low and medium are unsupported; from "low", forward scan should land on "high".
		expect(clampThinkingLevel(model, "low")).toBe("high");
	});

	it("backward-scans when the forward scan finds nothing", () => {
		// xhigh requested; no levels above it; not in map → not supported → forward exhausts → backward to "high".
		const model = makeFakeModel({ reasoning: true });
		const result = clampThinkingLevel(model, "xhigh" as ModelThinkingLevel);
		expect(result).toBe("high");
	});

	it("returns the first available level when the requested level is not in the extended list", () => {
		const model = makeFakeModel({ reasoning: true });
		// passing a string that doesn't match any known thinking level → indexOf === -1 → returns first available
		expect(clampThinkingLevel(model, "bogus" as ModelThinkingLevel)).toBe("off");
	});

	it("falls back to 'off' when no supported levels exist (reasoning=false yields only ['off'])", () => {
		const model = makeFakeModel({ reasoning: false });
		expect(clampThinkingLevel(model, "high")).toBe("off");
	});

	it("falls back to 'off' on bogus level when reasoning is true and 'off' is supported", () => {
		const model = makeFakeModel({ reasoning: true });
		expect(clampThinkingLevel(model, "totally-unknown" as ModelThinkingLevel)).toBe("off");
	});

	// Edge: reasoning=true, all base levels nulled out → availableLevels = [] → both fallback branches return "off".
	it("nullable-empty thinkingLevelMap (all levels nulled) on reasoning=true falls back to 'off'", () => {
		const model = makeFakeModel({
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null },
		});
		// No supported levels → availableLevels is [] → availableLevels[0] ?? "off" → "off".
		expect(clampThinkingLevel(model, "low")).toBe("off");
		expect(clampThinkingLevel(model, "bogus" as ModelThinkingLevel)).toBe("off");
	});
});

describe("modelsAreEqual", () => {
	it("returns true when both id and provider match", () => {
		const a = makeFakeModel({ id: "x", provider: "openai" });
		const b = makeFakeModel({ id: "x", provider: "openai" });
		expect(modelsAreEqual(a, b)).toBe(true);
	});

	it("returns false when ids differ", () => {
		const a = makeFakeModel({ id: "x", provider: "openai" });
		const b = makeFakeModel({ id: "y", provider: "openai" });
		expect(modelsAreEqual(a, b)).toBe(false);
	});

	it("returns false when providers differ", () => {
		const a = makeFakeModel({ id: "x", provider: "openai" });
		const b = makeFakeModel({ id: "x", provider: "openrouter" });
		expect(modelsAreEqual(a, b)).toBe(false);
	});

	it("returns false when a is null", () => {
		expect(modelsAreEqual(null, makeFakeModel())).toBe(false);
	});

	it("returns false when b is null", () => {
		expect(modelsAreEqual(makeFakeModel(), null)).toBe(false);
	});

	it("returns false when both are null", () => {
		expect(modelsAreEqual(null, null)).toBe(false);
	});

	it("returns false when a is undefined", () => {
		expect(modelsAreEqual(undefined, makeFakeModel())).toBe(false);
	});

	it("returns false when b is undefined", () => {
		expect(modelsAreEqual(makeFakeModel(), undefined)).toBe(false);
	});
});
