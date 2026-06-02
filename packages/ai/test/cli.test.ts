import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { OAuthProviderInterface } from "../src/utils/oauth/types.js";

const originalCwd = process.cwd();

const mockState = vi.hoisted(() => ({
	promptDuringLogin: false,
	promptPlaceholder: "code" as string | undefined,
	provider: {
		id: "openai-codex",
		name: "ChatGPT Plus/Pro (Codex Subscription)",
		usesCallbackServer: true,
		login: vi.fn(async (callbacks) => {
			callbacks.onAuth({ url: "https://auth.example.test", instructions: "Finish auth." });
			callbacks.onProgress?.("working");
			if (mockState.promptDuringLogin) {
				await callbacks.onPrompt({ message: "Paste code", placeholder: mockState.promptPlaceholder });
			}
			return {
				access: "access-token",
				refresh: "refresh-token",
				expires: 123,
				accountId: "account-1",
			};
		}),
		refreshToken: vi.fn(),
		getApiKey: vi.fn((credentials) => credentials.access),
	} satisfies OAuthProviderInterface,
}));

vi.mock("../src/utils/oauth/index.js", () => ({
	getOAuthProvider: (id: string) => (id === mockState.provider.id ? mockState.provider : undefined),
	getOAuthProviders: () => [mockState.provider],
}));

afterEach(() => {
	process.chdir(originalCwd);
	mockState.promptDuringLogin = false;
	mockState.promptPlaceholder = "code";
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

function captureConsole(): { logs: string[]; errors: string[] } {
	const logs: string[] = [];
	const errors: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args) => {
		logs.push(args.join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...args) => {
		errors.push(args.join(" "));
	});
	return { logs, errors };
}

function throwOnExit(): void {
	vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
		throw new Error(`exit ${code ?? 0}`);
	});
}

function inputWith(text: string): PassThrough {
	const input = new PassThrough();
	input.end(text);
	return input;
}

describe("pi-ai CLI", () => {
	it("prints help with Bun-first examples", async () => {
		const output = captureConsole();

		await main(["--help"]);

		expect(output.logs.join("\n")).toContain("Usage: bunx @earendil-works/pi-ai <command> [provider]");
		expect(output.logs.join("\n")).toContain("bunx @earendil-works/pi-ai login anthropic");
		expect(output.errors).toEqual([]);
	});

	it("lists available OAuth providers", async () => {
		const output = captureConsole();

		await main(["list"]);

		expect(output.logs.join("\n")).toContain("Available OAuth providers:");
		expect(output.logs.join("\n")).toContain("openai-codex");
		expect(output.logs.join("\n")).toContain("ChatGPT Plus/Pro");
		expect(output.errors).toEqual([]);
	});

	it("logs in to a selected provider and writes auth.json", async () => {
		const output = captureConsole();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-ai-cli-"));
		process.chdir(tempDir);
		writeFileSync(join(tempDir, "auth.json"), "{not-json", "utf8");

		await main(["login", "openai-codex"]);

		expect(mockState.provider.login).toHaveBeenCalledOnce();
		expect(output.logs.join("\n")).toContain("Logging in to openai-codex...");
		expect(output.logs.join("\n")).toContain("Open this URL in your browser:");
		expect(output.logs.join("\n")).toContain("Credentials saved to auth.json");
		expect(JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"))).toEqual({
			"openai-codex": {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: 123,
				accountId: "account-1",
			},
		});
		expect(output.errors).toEqual([]);
	});

	it("wires provider prompt callbacks to the CLI input stream", async () => {
		mockState.promptDuringLogin = true;
		const output = captureConsole();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-ai-cli-"));
		process.chdir(tempDir);

		await main(["login", "openai-codex"], { input: inputWith("manual-code\n"), output: new PassThrough() });

		expect(mockState.provider.login).toHaveBeenCalledOnce();
		expect(JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"))).toMatchObject({
			"openai-codex": { access: "access-token" },
		});
		expect(output.errors).toEqual([]);
	});

	it("prompts without placeholder text when the provider omits it", async () => {
		mockState.promptDuringLogin = true;
		mockState.promptPlaceholder = undefined;
		const output = captureConsole();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-ai-cli-"));
		process.chdir(tempDir);

		await main(["login", "openai-codex"], { input: inputWith("manual-code\n"), output: new PassThrough() });

		expect(mockState.provider.login).toHaveBeenCalledOnce();
		expect(JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"))).toMatchObject({
			"openai-codex": { refresh: "refresh-token" },
		});
		expect(output.errors).toEqual([]);
	});

	it("supports interactive provider selection and invalid choices", async () => {
		const output = captureConsole();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-ai-cli-"));
		process.chdir(tempDir);

		await main(["login"], { input: inputWith("1\n"), output: new PassThrough() });

		expect(mockState.provider.login).toHaveBeenCalledOnce();
		expect(output.logs.join("\n")).toContain("Select a provider:");
		expect(JSON.parse(readFileSync(join(tempDir, "auth.json"), "utf8"))).toMatchObject({
			"openai-codex": { access: "access-token" },
		});

		output.errors.length = 0;
		throwOnExit();
		await expect(main(["login"], { input: inputWith("99\n"), output: new PassThrough() })).rejects.toThrow("exit 1");
		expect(output.errors).toEqual(["Invalid selection"]);
	});

	it("reports unknown commands and provider ids", async () => {
		const output = captureConsole();
		throwOnExit();

		await expect(main(["unknown"])).rejects.toThrow("exit 1");
		expect(output.errors).toEqual(["Unknown command: unknown", "Use 'bunx @earendil-works/pi-ai --help' for usage"]);

		output.errors.length = 0;
		await expect(main(["login", "missing-provider"])).rejects.toThrow("exit 1");
		expect(output.errors).toEqual([
			"Unknown provider: missing-provider",
			"Use 'bunx @earendil-works/pi-ai list' to see available providers",
		]);
	});
});
