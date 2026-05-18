import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	migrateAuthToAuthJson,
	migrateSessionsFromAgentRoot,
	runMigrations,
	showDeprecationWarnings,
} from "../src/migrations.js";

describe("migrations", () => {
	const tempDirs: string[] = [];
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	function makeTemp(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mig-"));
		tempDirs.push(dir);
		process.env[ENV_AGENT_DIR] = dir;
		return dir;
	}

	describe("migrateAuthToAuthJson", () => {
		it("does nothing when auth.json already exists", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ existing: { type: "api_key", key: "k" } }));
			fs.writeFileSync(path.join(dir, "oauth.json"), JSON.stringify({ openrouter: { accessToken: "t" } }));
			const providers = migrateAuthToAuthJson();
			expect(providers).toEqual([]);
		});

		it("returns empty when no source files exist", () => {
			makeTemp();
			expect(migrateAuthToAuthJson()).toEqual([]);
		});

		it("migrates oauth.json into auth.json", () => {
			const dir = makeTemp();
			fs.writeFileSync(
				path.join(dir, "oauth.json"),
				JSON.stringify({ openrouter: { accessToken: "a", refreshToken: "r" } }),
			);
			const providers = migrateAuthToAuthJson();
			expect(providers).toEqual(["openrouter"]);

			const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
			expect(auth.openrouter.type).toBe("oauth");
			expect(auth.openrouter.accessToken).toBe("a");

			// Original renamed
			expect(fs.existsSync(path.join(dir, "oauth.json"))).toBe(false);
			expect(fs.existsSync(path.join(dir, "oauth.json.migrated"))).toBe(true);
		});

		it("migrates settings.json apiKeys into auth.json", () => {
			const dir = makeTemp();
			fs.writeFileSync(
				path.join(dir, "settings.json"),
				JSON.stringify({ apiKeys: { openai: "sk-key" }, other: "preserved" }),
			);
			const providers = migrateAuthToAuthJson();
			expect(providers).toContain("openai");

			const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
			expect(auth.openai).toEqual({ type: "api_key", key: "sk-key" });

			const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
			expect(settings.apiKeys).toBeUndefined();
			expect(settings.other).toBe("preserved");
		});

		it("prefers oauth over apiKey if both exist for a provider", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "oauth.json"), JSON.stringify({ openai: { accessToken: "oauth-token" } }));
			fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ apiKeys: { openai: "sk-key" } }));
			migrateAuthToAuthJson();
			const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
			expect(auth.openai.type).toBe("oauth");
		});

		it("survives malformed oauth.json", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "oauth.json"), "not-json");
			expect(() => migrateAuthToAuthJson()).not.toThrow();
		});

		it("survives malformed settings.json", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "settings.json"), "{garbage");
			expect(() => migrateAuthToAuthJson()).not.toThrow();
		});

		it("ignores non-string apiKey values", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ apiKeys: { broken: 42 } }));
			migrateAuthToAuthJson();
			expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
		});
	});

	describe("migrateSessionsFromAgentRoot", () => {
		it("returns silently when agentDir does not exist", () => {
			process.env[ENV_AGENT_DIR] = path.join(os.tmpdir(), `pi-nonexistent-${Date.now()}`);
			expect(() => migrateSessionsFromAgentRoot()).not.toThrow();
		});

		it("returns silently when no jsonl files", () => {
			makeTemp();
			expect(() => migrateSessionsFromAgentRoot()).not.toThrow();
		});

		it("moves loose jsonl files into sessions/<encoded-cwd>/", () => {
			const dir = makeTemp();
			const cwd = "/some/project";
			const header = JSON.stringify({ type: "session", cwd });
			fs.writeFileSync(path.join(dir, "abc.jsonl"), `${header}\n`);
			migrateSessionsFromAgentRoot();
			const encoded = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
			const moved = path.join(dir, "sessions", encoded, "abc.jsonl");
			expect(fs.existsSync(moved)).toBe(true);
			expect(fs.existsSync(path.join(dir, "abc.jsonl"))).toBe(false);
		});

		it("skips jsonl with empty first line", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "empty.jsonl"), "\n");
			migrateSessionsFromAgentRoot();
			expect(fs.existsSync(path.join(dir, "empty.jsonl"))).toBe(true);
		});

		it("skips jsonl with non-session header type", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "other.jsonl"), JSON.stringify({ type: "message" }));
			migrateSessionsFromAgentRoot();
			expect(fs.existsSync(path.join(dir, "other.jsonl"))).toBe(true);
		});

		it("skips when target file already exists", () => {
			const dir = makeTemp();
			const cwd = "/proj";
			const encoded = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
			fs.mkdirSync(path.join(dir, "sessions", encoded), { recursive: true });
			fs.writeFileSync(path.join(dir, "sessions", encoded, "dup.jsonl"), "existing");

			const header = JSON.stringify({ type: "session", cwd });
			fs.writeFileSync(path.join(dir, "dup.jsonl"), `${header}\n`);
			migrateSessionsFromAgentRoot();

			// Both files should still exist
			expect(fs.existsSync(path.join(dir, "dup.jsonl"))).toBe(true);
			expect(fs.readFileSync(path.join(dir, "sessions", encoded, "dup.jsonl"), "utf-8")).toBe("existing");
		});

		it("handles malformed jsonl gracefully", () => {
			const dir = makeTemp();
			fs.writeFileSync(path.join(dir, "bad.jsonl"), "not-json\n");
			expect(() => migrateSessionsFromAgentRoot()).not.toThrow();
		});
	});

	describe("runMigrations", () => {
		it("returns object with migrated providers and warnings", () => {
			const dir = makeTemp();
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-"));
			tempDirs.push(cwd);
			const result = runMigrations(cwd);
			expect(result).toHaveProperty("migratedAuthProviders");
			expect(result).toHaveProperty("deprecationWarnings");
			expect(Array.isArray(result.migratedAuthProviders)).toBe(true);
			expect(Array.isArray(result.deprecationWarnings)).toBe(true);
			void dir;
		});

		it("renames commands/ to prompts/", () => {
			const dir = makeTemp();
			const cmdDir = path.join(dir, "commands");
			fs.mkdirSync(cmdDir, { recursive: true });
			fs.writeFileSync(path.join(cmdDir, "my-cmd.md"), "test");

			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-"));
			tempDirs.push(cwd);

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			runMigrations(cwd);
			logSpy.mockRestore();

			expect(fs.existsSync(path.join(dir, "prompts", "my-cmd.md"))).toBe(true);
			expect(fs.existsSync(cmdDir)).toBe(false);
		});

		it("warns about hooks/ directory", () => {
			const dir = makeTemp();
			fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });

			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-"));
			tempDirs.push(cwd);

			const result = runMigrations(cwd);
			expect(result.deprecationWarnings.some((w) => w.includes("hooks/"))).toBe(true);
		});

		it("warns about tools/ with custom binaries (not just fd/rg)", () => {
			const dir = makeTemp();
			const toolsDir = path.join(dir, "tools");
			fs.mkdirSync(toolsDir, { recursive: true });
			fs.writeFileSync(path.join(toolsDir, "my-custom-tool.js"), "// custom");

			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-"));
			tempDirs.push(cwd);

			const result = runMigrations(cwd);
			expect(result.deprecationWarnings.some((w) => w.includes("tools/"))).toBe(true);
		});

		it("does not warn for tools/ containing only fd/rg", () => {
			const dir = makeTemp();
			const toolsDir = path.join(dir, "tools");
			fs.mkdirSync(toolsDir, { recursive: true });
			fs.writeFileSync(path.join(toolsDir, "fd"), "");
			fs.writeFileSync(path.join(toolsDir, "rg"), "");

			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-"));
			tempDirs.push(cwd);

			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const result = runMigrations(cwd);
			logSpy.mockRestore();
			expect(result.deprecationWarnings.some((w) => w.includes("tools/"))).toBe(false);
		});
	});

	describe("showDeprecationWarnings", () => {
		it("returns immediately with no warnings", async () => {
			await expect(showDeprecationWarnings([])).resolves.toBeUndefined();
		});

		// Note: showDeprecationWarnings with non-empty warnings reads stdin,
		// which can't be tested easily without a TTY. We rely on the empty case.
	});
});
