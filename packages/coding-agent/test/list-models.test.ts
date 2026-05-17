import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.js";
import type { ModelRegistry } from "../src/core/model-registry.js";

function makeModel(provider: string, id: string, opts: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages" as Api,
		provider,
		baseUrl: "https://test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...opts,
	};
}

function makeRegistry(models: Model<Api>[], loadError?: string): ModelRegistry {
	return {
		getError: () => loadError,
		getAvailable: () => models,
	} as unknown as ModelRegistry;
}

describe("listModels", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
	});

	it("prints no-models help when registry empty", async () => {
		await listModels(makeRegistry([]));
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No models available"));
	});

	it("prints load error warning", async () => {
		await listModels(makeRegistry([], "bad config"));
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("bad config"));
	});

	it("prints table headers and rows when models exist", async () => {
		const models = [
			makeModel("anthropic", "claude-sonnet"),
			makeModel("openai", "gpt-5.4", { reasoning: true, input: ["text", "image"] }),
		];
		await listModels(makeRegistry(models));
		const allOutput = logSpy.mock.calls.flat().join("\n");
		expect(allOutput).toContain("provider");
		expect(allOutput).toContain("model");
		expect(allOutput).toContain("anthropic");
		expect(allOutput).toContain("openai");
		expect(allOutput).toContain("gpt-5.4");
	});

	it("formats context window with K/M suffix", async () => {
		const models = [
			makeModel("p1", "m1", { contextWindow: 500 }),
			makeModel("p2", "m2", { contextWindow: 200_000 }),
			makeModel("p3", "m3", { contextWindow: 1_000_000 }),
			makeModel("p4", "m4", { contextWindow: 1_500_000 }),
			makeModel("p5", "m5", { contextWindow: 1_500 }),
		];
		await listModels(makeRegistry(models));
		const out = logSpy.mock.calls.flat().join("\n");
		expect(out).toContain("500");
		expect(out).toContain("200K");
		expect(out).toContain("1M");
		expect(out).toContain("1.5M");
		expect(out).toContain("1.5K");
	});

	it("filters by search pattern (fuzzy)", async () => {
		const models = [
			makeModel("anthropic", "claude-sonnet"),
			makeModel("openai", "gpt-5.4"),
			makeModel("openai", "gpt-4"),
		];
		await listModels(makeRegistry(models), "gpt");
		const out = logSpy.mock.calls.flat().join("\n");
		expect(out).toContain("gpt-5.4");
		expect(out).toContain("gpt-4");
		expect(out).not.toContain("claude-sonnet");
	});

	it("prints no-match message when pattern yields nothing", async () => {
		const models = [makeModel("anthropic", "claude")];
		await listModels(makeRegistry(models), "xyz-nonexistent");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No models matching "xyz-nonexistent"'));
	});

	it("displays yes/no for thinking and images flags", async () => {
		const models = [
			makeModel("p1", "no-think", { reasoning: false, input: ["text"] }),
			makeModel("p2", "yes-think-images", { reasoning: true, input: ["text", "image"] }),
		];
		await listModels(makeRegistry(models));
		const out = logSpy.mock.calls.flat().join("\n");
		expect(out).toContain("yes");
		expect(out).toContain("no");
	});

	it("sorts by provider then id", async () => {
		const models = [makeModel("z-prov", "z"), makeModel("a-prov", "z"), makeModel("a-prov", "a")];
		await listModels(makeRegistry(models));
		const calls = logSpy.mock.calls.flat() as string[];
		const dataRows = calls.filter((l) => l.includes("a-prov") || l.includes("z-prov"));
		expect(dataRows[0]).toContain("a-prov");
		expect(dataRows[0]).toContain(" a ");
		expect(dataRows[2]).toContain("z-prov");
	});
});
