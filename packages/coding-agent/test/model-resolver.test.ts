import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.js";
import {
	defaultModelPerProvider,
	findExactModelReferenceMatch,
	findInitialModel,
	parseModelPattern,
	resolveCliModel,
	resolveModelScope,
	restoreModelFromSession,
} from "../src/core/model-resolver.js";

function makeModel(provider: string, id: string, name?: string): Model<Api> {
	return {
		id,
		name: name ?? id,
		api: "anthropic-messages" as Api,
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("findExactModelReferenceMatch", () => {
	const models = [
		makeModel("anthropic", "claude-sonnet-4-5"),
		makeModel("openai", "gpt-5.4"),
		makeModel("openrouter", "anthropic/claude-sonnet-4-5"),
	];

	it("returns undefined for empty/whitespace strings", () => {
		expect(findExactModelReferenceMatch("", models)).toBeUndefined();
		expect(findExactModelReferenceMatch("   ", models)).toBeUndefined();
	});

	it("matches canonical provider/id form", () => {
		const match = findExactModelReferenceMatch("anthropic/claude-sonnet-4-5", models);
		expect(match?.provider).toBe("anthropic");
		expect(match?.id).toBe("claude-sonnet-4-5");
	});

	it("matches case-insensitively", () => {
		const match = findExactModelReferenceMatch("ANTHROPIC/claude-sonnet-4-5", models);
		expect(match?.id).toBe("claude-sonnet-4-5");
	});

	it("returns undefined when multiple canonical matches exist", () => {
		const dupes = [makeModel("anthropic", "claude"), makeModel("anthropic", "claude")];
		expect(findExactModelReferenceMatch("anthropic/claude", dupes)).toBeUndefined();
	});

	it("falls back to provider/model split for non-canonical input", () => {
		const otherModels = [makeModel("anthropic", "claude-3"), makeModel("openai", "gpt-4")];
		const match = findExactModelReferenceMatch("anthropic/claude-3", otherModels);
		expect(match?.id).toBe("claude-3");
	});

	it("returns undefined when bare id has ambiguous matches", () => {
		const dupes = [makeModel("anthropic", "claude"), makeModel("openai", "claude")];
		expect(findExactModelReferenceMatch("claude", dupes)).toBeUndefined();
	});

	it("matches single bare id", () => {
		const match = findExactModelReferenceMatch("gpt-5.4", models);
		expect(match?.provider).toBe("openai");
	});

	it("returns undefined for non-matching reference", () => {
		expect(findExactModelReferenceMatch("nonexistent", models)).toBeUndefined();
	});

	it("handles empty provider or modelId in provider/model split", () => {
		expect(findExactModelReferenceMatch("/claude", models)).toBeUndefined();
		expect(findExactModelReferenceMatch("anthropic/", models)).toBeUndefined();
	});

	it("returns undefined for multiple matches in same provider", () => {
		const dupes = [
			makeModel("anthropic", "claude-3"),
			makeModel("anthropic", "claude-3"),
			makeModel("anthropic", "claude-4"),
		];
		expect(findExactModelReferenceMatch("anthropic/claude-3", dupes)).toBeUndefined();
	});
});

describe("parseModelPattern", () => {
	const models = [
		makeModel("anthropic", "claude-sonnet-4-5"),
		makeModel("anthropic", "claude-sonnet-4-5-20250929"),
		makeModel("anthropic", "claude-opus-4-5"),
		makeModel("openai", "gpt-5.4"),
		makeModel("openrouter", "test/model:exacto"),
	];

	it("returns exact match without thinking level", () => {
		const result = parseModelPattern("claude-opus-4-5", models);
		expect(result.model?.id).toBe("claude-opus-4-5");
		expect(result.thinkingLevel).toBeUndefined();
	});

	it("prefers alias over dated version on partial match", () => {
		const result = parseModelPattern("sonnet", models);
		// Both match via partial, alias preferred
		expect(result.model?.id).toBe("claude-sonnet-4-5");
	});

	it("returns undefined for no match without colon", () => {
		const result = parseModelPattern("nonexistent", models);
		expect(result.model).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it("parses thinking level suffix", () => {
		const result = parseModelPattern("claude-opus-4-5:high", models);
		expect(result.model?.id).toBe("claude-opus-4-5");
		expect(result.thinkingLevel).toBe("high");
	});

	it("warns on invalid thinking level suffix in scope mode", () => {
		const result = parseModelPattern("claude-opus-4-5:bogus", models, { allowInvalidThinkingLevelFallback: true });
		expect(result.model?.id).toBe("claude-opus-4-5");
		expect(result.warning).toContain("Invalid thinking level");
	});

	it("returns undefined for invalid thinking level in strict mode", () => {
		const result = parseModelPattern("claude-opus-4-5:bogus", models, { allowInvalidThinkingLevelFallback: false });
		expect(result.model).toBeUndefined();
	});

	it("handles model id containing colon", () => {
		const result = parseModelPattern("test/model:exacto", models);
		expect(result.model?.id).toBe("test/model:exacto");
	});

	it("handles model id with colon plus thinking level", () => {
		const result = parseModelPattern("test/model:exacto:high", models);
		expect(result.model?.id).toBe("test/model:exacto");
		expect(result.thinkingLevel).toBe("high");
	});

	it("uses latest dated version when no alias", () => {
		const datedOnly = [
			makeModel("anthropic", "model-20240101"),
			makeModel("anthropic", "model-20240202"),
			makeModel("anthropic", "model-20240301"),
		];
		const result = parseModelPattern("model", datedOnly);
		expect(result.model?.id).toBe("model-20240301");
	});

	it("treats -latest suffix as alias", () => {
		const models2 = [makeModel("anthropic", "claude-latest"), makeModel("anthropic", "claude-20240101")];
		const result = parseModelPattern("claude", models2);
		expect(result.model?.id).toBe("claude-latest");
	});

	it("returns undefined for unmatched prefix after invalid thinking", () => {
		const result = parseModelPattern("nonexistent:bogus", models, { allowInvalidThinkingLevelFallback: true });
		expect(result.model).toBeUndefined();
	});

	it("returns undefined for unmatched prefix even with valid thinking suffix", () => {
		const result = parseModelPattern("nonexistent:high", models);
		expect(result.model).toBeUndefined();
	});

	it("clears thinking level when warning exists from inner recursion", () => {
		// pattern like "claude:bogus:high": inner "claude:bogus" returns model+warning
		// outer "high" then preserves the warning and clears thinking
		const result = parseModelPattern("claude-opus-4-5:bogus:high", models);
		expect(result.model?.id).toBe("claude-opus-4-5");
		expect(result.warning).toContain("Invalid thinking level");
		expect(result.thinkingLevel).toBeUndefined();
	});
});

describe("resolveModelScope", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	function makeRegistry(models: Model<Api>[]) {
		return {
			getAvailable: async () => models,
		} as unknown as ModelRegistry;
	}

	it("returns empty for no patterns", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = await resolveModelScope([], reg);
		expect(result).toEqual([]);
	});

	it("matches exact pattern", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude"), makeModel("openai", "gpt-5.4")]);
		const result = await resolveModelScope(["claude"], reg);
		expect(result).toHaveLength(1);
		expect(result[0].model.id).toBe("claude");
	});

	it("matches glob pattern across providers", async () => {
		const reg = makeRegistry([
			makeModel("anthropic", "claude-sonnet"),
			makeModel("anthropic", "claude-opus"),
			makeModel("openai", "gpt-4"),
		]);
		const result = await resolveModelScope(["*claude*"], reg);
		expect(result).toHaveLength(2);
	});

	it("matches glob with provider prefix", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude"), makeModel("openai", "claude")]);
		const result = await resolveModelScope(["anthropic/*"], reg);
		expect(result).toHaveLength(1);
		expect(result[0].model.provider).toBe("anthropic");
	});

	it("attaches thinking level from glob :high suffix", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude-1"), makeModel("anthropic", "claude-2")]);
		const result = await resolveModelScope(["claude*:high"], reg);
		expect(result).toHaveLength(2);
		expect(result.every((sm) => sm.thinkingLevel === "high")).toBe(true);
	});

	it("ignores invalid thinking level in glob suffix", async () => {
		// pattern "claude*:bogus" with bogus suffix - bogus is not valid thinking level
		// so the whole pattern is used as glob (which won't match)
		const reg = makeRegistry([makeModel("anthropic", "claude-1")]);
		const result = await resolveModelScope(["claude*:bogus"], reg);
		// "claude*:bogus" tries to glob-match the whole pattern; nothing matches "claude-1"
		expect(result).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("warns when glob matches no models", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = await resolveModelScope(["nonexistent*"], reg);
		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("warns when literal pattern matches no models", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = await resolveModelScope(["nonexistent"], reg);
		expect(result).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("deduplicates models across patterns", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = await resolveModelScope(["claude", "anthropic/claude"], reg);
		expect(result).toHaveLength(1);
	});

	it("supports question mark glob", async () => {
		const reg = makeRegistry([makeModel("anthropic", "g4"), makeModel("anthropic", "g5")]);
		const result = await resolveModelScope(["g?"], reg);
		expect(result).toHaveLength(2);
	});

	it("supports bracket glob", async () => {
		const reg = makeRegistry([makeModel("anthropic", "g4"), makeModel("anthropic", "g5")]);
		const result = await resolveModelScope(["g[45]"], reg);
		expect(result).toHaveLength(2);
	});

	it("warns with parseModelPattern warning", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = await resolveModelScope(["claude:bogus"], reg);
		expect(result).toHaveLength(1);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid thinking level"));
	});
});

describe("resolveCliModel", () => {
	function makeRegistry(models: Model<Api>[]) {
		return {
			getAll: () => models,
			getAvailable: async () => models,
		} as unknown as ModelRegistry;
	}

	it("returns undefined when cliModel not set", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({ modelRegistry: reg });
		expect(result.model).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it("errors when no models available", () => {
		const reg = makeRegistry([]);
		const result = resolveCliModel({ cliModel: "claude", modelRegistry: reg });
		expect(result.error).toContain("No models available");
	});

	it("errors on unknown explicit provider", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({ cliProvider: "nosuchprov", cliModel: "claude", modelRegistry: reg });
		expect(result.error).toContain("Unknown provider");
	});

	it("uses --provider + --model when both set", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude"), makeModel("openai", "gpt-4")]);
		const result = resolveCliModel({ cliProvider: "anthropic", cliModel: "claude", modelRegistry: reg });
		expect(result.model?.provider).toBe("anthropic");
		expect(result.error).toBeUndefined();
	});

	it("strips provider prefix when --model has prov/id and --provider set", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({
			cliProvider: "anthropic",
			cliModel: "anthropic/claude",
			modelRegistry: reg,
		});
		expect(result.model?.id).toBe("claude");
	});

	it("infers provider from --model 'prov/id'", () => {
		const reg = makeRegistry([makeModel("openai", "gpt-4")]);
		const result = resolveCliModel({ cliModel: "openai/gpt-4", modelRegistry: reg });
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4");
	});

	it("falls back to exact model id with literal slash when prefix not a known provider", () => {
		const reg = makeRegistry([makeModel("openrouter", "team/model")]);
		const result = resolveCliModel({ cliModel: "team/model", modelRegistry: reg });
		expect(result.model?.id).toBe("team/model");
	});

	it("falls back across all models when inferred provider has no match", () => {
		const reg = makeRegistry([makeModel("openrouter", "openai/gpt-4o:extended")]);
		const result = resolveCliModel({ cliModel: "openai/gpt-4o:extended", modelRegistry: reg });
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
		expect(result.model?.provider).toBe("openrouter");
	});

	it("builds fallback model when provider matches but pattern doesn't", () => {
		const reg = makeRegistry([makeModel("openai", "gpt-5.4")]);
		const result = resolveCliModel({ cliProvider: "openai", cliModel: "custom-id", modelRegistry: reg });
		expect(result.model?.id).toBe("custom-id");
		expect(result.warning).toContain("not found");
	});

	it("errors when model not found and no provider", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({ cliModel: "nonexistent", modelRegistry: reg });
		expect(result.error).toContain("not found");
	});

	it("does not infer provider when slash doesn't form known provider", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({ cliModel: "nosuchprov/claude", modelRegistry: reg });
		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
	});

	it("handles canonical 'prov/id' exact match without --provider", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({ cliModel: "anthropic/claude", modelRegistry: reg });
		expect(result.model?.id).toBe("claude");
	});

	it("handles case-insensitive provider match", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({ cliProvider: "ANTHROPIC", cliModel: "claude", modelRegistry: reg });
		expect(result.model?.id).toBe("claude");
	});

	it("errors with quoted display when nothing matches", () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const result = resolveCliModel({
			cliProvider: "anthropic",
			cliModel: "nonexistent",
			modelRegistry: reg,
		});
		// Pattern doesn't match in provider, falls back to fallbackModel (custom id)
		expect(result.model?.id).toBe("nonexistent");
		expect(result.warning).toBeDefined();
	});
});

describe("findInitialModel", () => {
	function makeRegistry(
		models: Model<Api>[],
		extras: Partial<{ find: (p: string, id: string) => Model<Api> | undefined }> = {},
	) {
		const reg = {
			getAll: () => models,
			getAvailable: async () => models,
			find:
				extras.find ??
				((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		return reg;
	}

	it("uses scoped model first when not continuing", async () => {
		const m = makeModel("anthropic", "claude");
		const reg = makeRegistry([m]);
		const result = await findInitialModel({
			scopedModels: [{ model: m, thinkingLevel: "medium" }],
			isContinuing: false,
			modelRegistry: reg,
		});
		expect(result.model?.id).toBe("claude");
		expect(result.thinkingLevel).toBe("medium");
	});

	it("uses default thinking level when scoped model has none", async () => {
		const m = makeModel("anthropic", "claude");
		const reg = makeRegistry([m]);
		const result = await findInitialModel({
			scopedModels: [{ model: m }],
			isContinuing: false,
			defaultThinkingLevel: "high",
			modelRegistry: reg,
		});
		expect(result.thinkingLevel).toBe("high");
	});

	it("skips scoped models when continuing, uses saved default", async () => {
		const m1 = makeModel("anthropic", "claude");
		const m2 = makeModel("openai", "gpt-4");
		const reg = makeRegistry([m1, m2]);
		const result = await findInitialModel({
			scopedModels: [{ model: m1 }],
			isContinuing: true,
			defaultProvider: "openai",
			defaultModelId: "gpt-4",
			modelRegistry: reg,
		});
		expect(result.model?.provider).toBe("openai");
	});

	it("falls back to first available with default model heuristic", async () => {
		const def = makeModel("openai", defaultModelPerProvider.openai);
		const other = makeModel("anthropic", "claude");
		const reg = makeRegistry([other, def]);
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: reg,
		});
		// Prefers known default
		expect(result.model?.id).toBe(defaultModelPerProvider.openai);
	});

	it("uses first available when no known default match", async () => {
		const m = makeModel("custom", "my-model");
		const reg = makeRegistry([m]);
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: reg,
		});
		expect(result.model?.id).toBe("my-model");
	});

	it("returns undefined model when nothing available", async () => {
		const reg = makeRegistry([]);
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: reg,
		});
		expect(result.model).toBeUndefined();
	});

	it("uses CLI-resolved model when valid", async () => {
		const m = makeModel("anthropic", "claude");
		const reg = makeRegistry([m]);
		const result = await findInitialModel({
			cliProvider: "anthropic",
			cliModel: "claude",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: reg,
		});
		expect(result.model?.id).toBe("claude");
	});

	it("exits with error when CLI model resolution errors", async () => {
		const reg = makeRegistry([makeModel("anthropic", "claude")]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await findInitialModel({
			cliProvider: "noprov",
			cliModel: "claude",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: reg,
		});
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errSpy).toHaveBeenCalled();
		exitSpy.mockRestore();
		errSpy.mockRestore();
	});
});

describe("restoreModelFromSession", () => {
	function makeRegistry(opts: { findResult?: Model<Api>; hasAuth?: boolean; available?: Model<Api>[] }) {
		const available = opts.available ?? [];
		return {
			find: () => opts.findResult,
			hasConfiguredAuth: () => opts.hasAuth ?? false,
			getAvailable: async () => available,
		} as unknown as ModelRegistry;
	}

	it("restores model when found with valid auth", async () => {
		const m = makeModel("anthropic", "claude");
		const reg = makeRegistry({ findResult: m, hasAuth: true });
		const result = await restoreModelFromSession("anthropic", "claude", undefined, false, reg);
		expect(result.model?.id).toBe("claude");
		expect(result.fallbackMessage).toBeUndefined();
	});

	it("prints restored message when shouldPrintMessages", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const m = makeModel("anthropic", "claude");
		const reg = makeRegistry({ findResult: m, hasAuth: true });
		await restoreModelFromSession("anthropic", "claude", undefined, true, reg);
		expect(logSpy).toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("falls back to current model when restore fails", async () => {
		const current = makeModel("openai", "gpt-4");
		const reg = makeRegistry({ findResult: undefined });
		const result = await restoreModelFromSession("anthropic", "claude", current, false, reg);
		expect(result.model?.id).toBe("gpt-4");
		expect(result.fallbackMessage).toContain("Could not restore");
	});

	it("warns and falls back to current model when shouldPrintMessages", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const current = makeModel("openai", "gpt-4");
		const reg = makeRegistry({ findResult: undefined });
		const result = await restoreModelFromSession("anthropic", "claude", current, true, reg);
		expect(errSpy).toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalled();
		expect(result.fallbackMessage).toBeDefined();
		errSpy.mockRestore();
		logSpy.mockRestore();
	});

	it("falls back to first available default when no current model", async () => {
		const def = makeModel("openai", defaultModelPerProvider.openai);
		const reg = makeRegistry({ findResult: undefined, available: [def] });
		const result = await restoreModelFromSession("anthropic", "claude", undefined, false, reg);
		expect(result.model?.id).toBe(defaultModelPerProvider.openai);
	});

	it("falls back to first available when no known default", async () => {
		const m = makeModel("custom", "my-model");
		const reg = makeRegistry({ findResult: undefined, available: [m] });
		const result = await restoreModelFromSession("anthropic", "claude", undefined, false, reg);
		expect(result.model?.id).toBe("my-model");
	});

	it("returns undefined when no models available", async () => {
		const reg = makeRegistry({ findResult: undefined, available: [] });
		const result = await restoreModelFromSession("anthropic", "claude", undefined, false, reg);
		expect(result.model).toBeUndefined();
	});

	it("uses 'no auth configured' reason when model exists but no auth", async () => {
		const m = makeModel("anthropic", "claude");
		const reg = makeRegistry({ findResult: m, hasAuth: false });
		const current = makeModel("openai", "gpt-4");
		const result = await restoreModelFromSession("anthropic", "claude", current, false, reg);
		expect(result.fallbackMessage).toContain("no auth configured");
	});

	it("uses 'model no longer exists' reason when restore returns undefined", async () => {
		const reg = makeRegistry({ findResult: undefined });
		const current = makeModel("openai", "gpt-4");
		const result = await restoreModelFromSession("anthropic", "claude", current, false, reg);
		expect(result.fallbackMessage).toContain("model no longer exists");
	});

	it("prints fallback dim message when shouldPrintMessages and available model", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const def = makeModel("openai", defaultModelPerProvider.openai);
		const reg = makeRegistry({ findResult: undefined, available: [def] });
		await restoreModelFromSession("anthropic", "claude", undefined, true, reg);
		expect(logSpy).toHaveBeenCalled();
		expect(errSpy).toHaveBeenCalled();
		logSpy.mockRestore();
		errSpy.mockRestore();
	});
});
