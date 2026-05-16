import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.js";

// The CLI calls main() at the bottom of src/cli.ts. To run main() in a way that
// is observable, we exercise the file with different process.argv / cwd /
// process.exit / console.log values and then dynamically import the module
// fresh each time. We patch readline so login flows can be driven from tests.

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

// Test-managed provider registry. cli.ts imports getOAuthProvider/getOAuthProviders
// from "./utils/oauth/index.js"; we mock that module to back it with this map
// so each test can swap in a custom provider deterministically.
const cliTestProviderRegistry = new Map<string, OAuthProviderInterface>();

interface CliRunOptions {
	argv: string[];
	cwd?: string;
	readlineAnswers?: string[];
	expectExit?: number;
	getOAuthProviderImpl?: (id: string) => OAuthProviderInterface | undefined;
}

interface CliRunResult {
	stdout: string[];
	stderr: string[];
	exitCode: number;
}

async function runCli(options: CliRunOptions): Promise<CliRunResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	let exitCode = 0;

	const originalCwd = process.cwd();
	const originalArgv = process.argv;

	const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		stdout.push(args.map(String).join(" "));
	});
	const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		stderr.push(args.map(String).join(" "));
	});

	let exitCalled = false;
	let resolveExit!: () => void;
	const exitPromise = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});

	// process.exit() in cli.ts must abort the current call site. We throw to
	// achieve that, then capture the unhandled rejection from main().catch via
	// our own unhandledRejection handler so vitest doesn't fail the test.
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
		if (!exitCalled) {
			exitCalled = true;
			exitCode = code;
			resolveExit();
		}
		throw new ExitError(code);
	}) as never);

	// Suppress unhandled rejection from cli.ts's main().catch handler when it
	// re-throws our ExitError.
	const unhandledHandler = (reason: unknown) => {
		if (reason instanceof ExitError) {
			return;
		}
		// Re-throw anything else so real errors still surface.
		throw reason;
	};
	process.on("unhandledRejection", unhandledHandler);

	process.argv = ["node", "cli.ts", ...options.argv];
	if (options.cwd) {
		process.chdir(options.cwd);
	}

	const answers = options.readlineAnswers ?? [];
	vi.doMock("node:readline", () => ({
		createInterface: () => {
			let i = 0;
			return {
				question: (_q: string, cb: (answer: string) => void) => {
					const ans = answers[i] ?? "";
					i++;
					queueMicrotask(() => cb(ans));
				},
				close: () => {},
			};
		},
	}));
	const getProvider = options.getOAuthProviderImpl ?? ((id: string) => cliTestProviderRegistry.get(id));
	vi.doMock("../src/utils/oauth/index.js", () => ({
		getOAuthProvider: getProvider,
		getOAuthProviders: () => Array.from(cliTestProviderRegistry.values()),
	}));

	// Drop cached cli.ts so its top-level main() re-runs with the new argv/mocks.
	vi.resetModules();

	try {
		await import(cliPath);
		// Wait for either:
		//  - a process.exit() call (resolveExit), or
		//  - the main()/main().catch() chain to settle (a couple of ticks).
		await Promise.race([
			exitPromise,
			new Promise<void>((resolve) => setTimeout(resolve, 100)),
		]);
		// Drain any pending microtasks from main().catch handlers
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	} catch (err) {
		if (!(err instanceof ExitError)) {
			throw err;
		}
	} finally {
		process.chdir(originalCwd);
		process.argv = originalArgv;
		logSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
		process.off("unhandledRejection", unhandledHandler);
		vi.doUnmock("node:readline");
		vi.doUnmock("../src/utils/oauth/index.js");
	}

	if (options.expectExit !== undefined) {
		expect(exitCode).toBe(options.expectExit);
	}

	return { stdout, stderr, exitCode };
}

class ExitError extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

let tmpDir: string;

const builtInOpenAICodexProvider: OAuthProviderInterface = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	usesCallbackServer: true,
	async login() {
		throw new Error("Real login should not run in tests");
	},
	async refreshToken(c) {
		return c;
	},
	getApiKey(c) {
		return c.access;
	},
};

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-cli-"));
	cliTestProviderRegistry.clear();
	cliTestProviderRegistry.set(builtInOpenAICodexProvider.id, builtInOpenAICodexProvider);
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	cliTestProviderRegistry.clear();
	vi.restoreAllMocks();
});

describe("cli help", () => {
	it("prints the usage message with no arguments", async () => {
		const { stdout, exitCode } = await runCli({ argv: [], cwd: tmpDir });
		expect(exitCode).toBe(0);
		const joined = stdout.join("\n");
		expect(joined).toContain("Usage:");
		expect(joined).toContain("Commands:");
		expect(joined).toContain("login [provider]");
		expect(joined).toContain("openai-codex");
	});

	it("prints usage for `help`", async () => {
		const { stdout } = await runCli({ argv: ["help"], cwd: tmpDir });
		expect(stdout.join("\n")).toContain("Usage:");
	});

	it("prints usage for `--help`", async () => {
		const { stdout } = await runCli({ argv: ["--help"], cwd: tmpDir });
		expect(stdout.join("\n")).toContain("Usage:");
	});

	it("prints usage for `-h`", async () => {
		const { stdout } = await runCli({ argv: ["-h"], cwd: tmpDir });
		expect(stdout.join("\n")).toContain("Usage:");
	});
});

describe("cli list", () => {
	it("prints the available OAuth providers", async () => {
		const { stdout, exitCode } = await runCli({ argv: ["list"], cwd: tmpDir });
		expect(exitCode).toBe(0);
		const out = stdout.join("\n");
		expect(out).toContain("Available OAuth providers:");
		expect(out).toContain("openai-codex");
		expect(out).toContain("ChatGPT");
	});
});

describe("cli unknown command", () => {
	it("exits 1 on an unknown command", async () => {
		const { stderr, exitCode } = await runCli({ argv: ["nope"], cwd: tmpDir });
		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("Unknown command: nope");
	});
});

describe("cli login", () => {
	function registerFakeProvider(credentials: OAuthCredentials, options?: { name?: string }) {
		const fake: OAuthProviderInterface = {
			id: "fake-test-provider",
			name: options?.name ?? "Fake Test Provider",
			async login(callbacks) {
				callbacks.onAuth({ url: "https://example.test/auth", instructions: "Open this URL" });
				callbacks.onProgress?.("progress message");
				const answer = await callbacks.onPrompt({ message: "Paste code", placeholder: "url-or-code" });
				expect(answer.length).toBeGreaterThan(0);
				return credentials;
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey(c) {
				return c.access;
			},
		};
		cliTestProviderRegistry.set(fake.id, fake);
		return () => cliTestProviderRegistry.delete(fake.id);
	}

	it("logs in to a specific provider and writes auth.json", async () => {
		const credentials: OAuthCredentials = {
			refresh: "rrr",
			access: "aaa",
			expires: Date.now() + 60_000,
			accountId: "acc-1",
		};
		const cleanup = registerFakeProvider(credentials);
		try {
			const { stdout, exitCode } = await runCli({
				argv: ["login", "fake-test-provider"],
				cwd: tmpDir,
				readlineAnswers: ["some-code"],
			});
			expect(exitCode).toBe(0);
			const out = stdout.join("\n");
			expect(out).toContain("Logging in to fake-test-provider");
			expect(out).toContain("https://example.test/auth");
			expect(out).toContain("Credentials saved to auth.json");

			const saved = JSON.parse(readFileSync(join(tmpDir, "auth.json"), "utf-8"));
			expect(saved["fake-test-provider"]).toMatchObject({
				type: "oauth",
				refresh: "rrr",
				access: "aaa",
				accountId: "acc-1",
			});
		} finally {
			cleanup();
		}
	});

	it("merges new credentials with an existing auth.json", async () => {
		writeFileSync(
			join(tmpDir, "auth.json"),
			JSON.stringify({ existing: { type: "oauth", refresh: "old-r", access: "old-a", expires: 0 } }, null, 2),
			"utf-8",
		);

		const credentials: OAuthCredentials = {
			refresh: "new-r",
			access: "new-a",
			expires: Date.now() + 60_000,
		};
		const cleanup = registerFakeProvider(credentials);
		try {
			await runCli({
				argv: ["login", "fake-test-provider"],
				cwd: tmpDir,
				readlineAnswers: ["code-for-merge"],
			});

			const saved = JSON.parse(readFileSync(join(tmpDir, "auth.json"), "utf-8"));
			expect(saved.existing).toBeDefined();
			expect(saved["fake-test-provider"]).toMatchObject({ access: "new-a" });
		} finally {
			cleanup();
		}
	});

	it("recovers from a corrupted auth.json", async () => {
		writeFileSync(join(tmpDir, "auth.json"), "{not valid json}", "utf-8");
		const credentials: OAuthCredentials = {
			refresh: "r",
			access: "a",
			expires: Date.now() + 60_000,
		};
		const cleanup = registerFakeProvider(credentials);
		try {
			await runCli({
				argv: ["login", "fake-test-provider"],
				cwd: tmpDir,
				readlineAnswers: ["any-code"],
			});

			const saved = JSON.parse(readFileSync(join(tmpDir, "auth.json"), "utf-8"));
			expect(saved["fake-test-provider"]).toMatchObject({ access: "a" });
			// Corrupted entry is gone; only the new provider exists.
			expect(Object.keys(saved)).toEqual(["fake-test-provider"]);
		} finally {
			cleanup();
		}
	});

	it("exits 1 for an unknown provider on `login <bad>`", async () => {
		const { stderr, exitCode } = await runCli({
			argv: ["login", "definitely-not-a-real-provider"],
			cwd: tmpDir,
		});
		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("Unknown provider: definitely-not-a-real-provider");
		expect(stderr.join("\n")).toContain("list");
	});

	it("prompts to choose a provider when none is specified", async () => {
		const credentials: OAuthCredentials = {
			refresh: "r",
			access: "a",
			expires: Date.now() + 60_000,
		};
		const cleanup = registerFakeProvider(credentials);
		try {
			const { stdout, exitCode } = await runCli({
				argv: ["login"],
				cwd: tmpDir,
				// First answer selects the second provider (1-indexed)
				readlineAnswers: ["2", "interactive-code"],
			});
			expect(exitCode).toBe(0);
			const out = stdout.join("\n");
			expect(out).toContain("Select a provider:");
			expect(out).toContain("Fake Test Provider");

			const saved = JSON.parse(readFileSync(join(tmpDir, "auth.json"), "utf-8"));
			expect(saved["fake-test-provider"]).toBeDefined();
		} finally {
			cleanup();
		}
	});

	it("exits 1 when the interactive selection is out of range", async () => {
		const { stderr, exitCode } = await runCli({
			argv: ["login"],
			cwd: tmpDir,
			readlineAnswers: ["9999"],
		});
		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("Invalid selection");
	});

	it("exits 1 when the interactive selection is below range", async () => {
		const { stderr, exitCode } = await runCli({
			argv: ["login"],
			cwd: tmpDir,
			readlineAnswers: ["0"],
		});
		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("Invalid selection");
	});

	it("exits 1 when login() throws", async () => {
		const bad: OAuthProviderInterface = {
			id: "throwing-provider",
			name: "Throws on login",
			async login() {
				throw new Error("kaboom");
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey(c) {
				return c.access;
			},
		};
		cliTestProviderRegistry.set(bad.id, bad);
		try {
			const { stderr, exitCode } = await runCli({
				argv: ["login", "throwing-provider"],
				cwd: tmpDir,
			});
			expect(exitCode).toBe(1);
			expect(stderr.join("\n")).toContain("Error: kaboom");
		} finally {
			cliTestProviderRegistry.delete(bad.id);
		}
	});

	it("guards against a provider that disappears between list and login", async () => {
		// Force a state where getOAuthProviders reports a provider id but
		// getOAuthProvider(id) returns undefined. This exercises the defensive
		// guard at the top of login().
		const ghost: OAuthProviderInterface = {
			id: "ghost-provider",
			name: "Ghost",
			async login() {
				return { refresh: "r", access: "a", expires: 0 };
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey(c) {
				return c.access;
			},
		};
		cliTestProviderRegistry.set(ghost.id, ghost);

		const { stderr, exitCode } = await runCli({
			argv: ["login", "ghost-provider"],
			cwd: tmpDir,
			getOAuthProviderImpl: (id: string) => (id === "ghost-provider" ? undefined : cliTestProviderRegistry.get(id)),
		});
		expect(exitCode).toBe(1);
		expect(stderr.join("\n")).toContain("Unknown provider: ghost-provider");
	});

	it("prints onAuth info without instructions when none are supplied", async () => {
		const fake: OAuthProviderInterface = {
			id: "no-instr-prov",
			name: "No instructions provider",
			async login(callbacks) {
				callbacks.onAuth({ url: "https://example.test/auth-only" });
				await callbacks.onPrompt({ message: "code?" });
				return { refresh: "r", access: "a", expires: Date.now() + 1000 };
			},
			async refreshToken(c) {
				return c;
			},
			getApiKey(c) {
				return c.access;
			},
		};
		cliTestProviderRegistry.set(fake.id, fake);
		try {
			const { stdout } = await runCli({
				argv: ["login", "no-instr-prov"],
				cwd: tmpDir,
				readlineAnswers: ["x"],
			});
			const out = stdout.join("\n");
			expect(out).toContain("https://example.test/auth-only");
			// onAuth.info.instructions was not provided, so the CLI must not
			// print any instructions block beyond "Open this URL in your browser".
			expect(out).toContain("Open this URL in your browser:");
			// No second line of instructional content after the URL.
			const lines = out.split("\n");
			const urlLineIdx = lines.findIndex((l) => l.includes("auth-only"));
			expect(urlLineIdx).toBeGreaterThan(-1);
			expect(lines[urlLineIdx + 1] ?? "").toBe("");
		} finally {
			cliTestProviderRegistry.delete(fake.id);
		}
	});
});
