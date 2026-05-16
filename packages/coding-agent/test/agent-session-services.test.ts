import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("createAgentSessionServices", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-services-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds default services from cwd alone", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		expect(services.cwd).toBe(tempDir);
		expect(services.agentDir).toBe(tempDir);
		expect(services.authStorage).toBeDefined();
		expect(services.settingsManager).toBeDefined();
		expect(services.modelRegistry).toBeDefined();
		expect(services.resourceLoader).toBeDefined();
		expect(services.diagnostics).toEqual([]);
	});

	it("accepts pre-built authStorage and settingsManager and modelRegistry", async () => {
		const authStorage = AuthStorage.inMemory();
		const settingsManager = SettingsManager.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			settingsManager,
			modelRegistry,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		expect(services.authStorage).toBe(authStorage);
		expect(services.settingsManager).toBe(settingsManager);
		expect(services.modelRegistry).toBe(modelRegistry);
	});

	it("emits error diagnostic when extension flag is unknown", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			extensionFlagValues: new Map<string, boolean | string>([["nosuchflag", true]]),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		expect(services.diagnostics.some((d) => d.type === "error" && d.message.includes("Unknown option"))).toBe(true);
	});

	it("emits diagnostic when string flag has no value", async () => {
		// Need to register a flag via an extension. Use an inline factory.
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			extensionFlagValues: new Map<string, boolean | string>([["myflag", true as never]]),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(api) => {
						api.registerFlag("myflag", { type: "string" });
					},
				],
			},
		});

		expect(services.diagnostics.some((d) => d.type === "error" && d.message.includes("requires a value"))).toBe(true);
	});

	it("accepts boolean flag through extension flag values", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			extensionFlagValues: new Map<string, boolean | string>([["mybool", true]]),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(api) => {
						api.registerFlag("mybool", { type: "boolean" });
					},
				],
			},
		});

		expect(services.diagnostics.filter((d) => d.type === "error")).toEqual([]);
		const runtime = services.resourceLoader.getExtensions().runtime;
		expect(runtime.flagValues.get("mybool")).toBe(true);
	});

	it("accepts string flag with value", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			extensionFlagValues: new Map<string, boolean | string>([["mystr", "value"]]),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(api) => {
						api.registerFlag("mystr", { type: "string" });
					},
				],
			},
		});

		expect(services.diagnostics.filter((d) => d.type === "error")).toEqual([]);
		const runtime = services.resourceLoader.getExtensions().runtime;
		expect(runtime.flagValues.get("mystr")).toBe("value");
	});

	it("reports multiple unknown flags in one error message", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			extensionFlagValues: new Map<string, boolean | string>([
				["flag-a", true],
				["flag-b", "value"],
			]),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const err = services.diagnostics.find((d) => d.type === "error" && d.message.includes("Unknown options"));
		expect(err?.message).toContain("--flag-a");
		expect(err?.message).toContain("--flag-b");
	});

	it("returns empty diagnostics when no extension flag values provided", async () => {
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		expect(services.diagnostics).toEqual([]);
	});
});
